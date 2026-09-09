import type { Logger } from "./logging.js";
import { errorMessage } from "./errors.js";
import type { OpenApiDocument } from "./registry/schemaFromOpenApi.js";
import type { SchemaRegistry } from "./registry/schemaRegistry.js";

export const fetchOpenApiDoc = async (url: string, timeoutMs: number): Promise<OpenApiDocument> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`OpenAPI doc fetch failed with status ${response.status}`);
    }
    return (await response.json()) as OpenApiDocument;
  } finally {
    clearTimeout(timer);
  }
};

export interface RefreshLoopConfig {
  openApiDocsUrl: string;
  openApiFetchTimeoutMs: number;
  openApiRefreshIntervalS: number;
}

/**
 * Fires an immediate refresh, then one every `openApiRefreshIntervalS`. Never
 * throws: a failed fetch is logged and the registry keeps its current
 * schemas. This single loop covers both the spec's "startup fallback" and
 * "steady-state fallback" cases — startup is simply the loop's first tick,
 * fired synchronously rather than waiting for the interval.
 *
 * `onRefreshed` runs after each *successful* `registry.refresh`. Refreshing the
 * registry is only half the job: the caller uses this hook to re-advertise the
 * new schemas to connected MCP clients, without which a background refresh
 * changes nothing anyone can observe.
 */
export const startOpenApiRefreshLoop = (
  registry: SchemaRegistry,
  config: RefreshLoopConfig,
  logger: Logger,
  onRefreshed?: () => void
): (() => void) => {
  const refreshOnce = (): void => {
    fetchOpenApiDoc(config.openApiDocsUrl, config.openApiFetchTimeoutMs)
      .then((doc) => {
        registry.refresh(doc, logger);
        onRefreshed?.();
        logger.info("openapi schema refresh ok");
      })
      .catch((err) => {
        logger.warn("openapi schema refresh failed, keeping last-known-good schemas", {
          error: errorMessage(err),
        });
      });
  };

  refreshOnce();
  const timer = setInterval(refreshOnce, config.openApiRefreshIntervalS * 1000);
  timer.unref();
  return () => clearInterval(timer);
};
