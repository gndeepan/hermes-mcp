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

export interface PrimeConfig {
  openApiDocsUrl: string;
  openApiFetchTimeoutMs: number;
}

/**
 * Brings the registry up to the live specification, once, at startup.
 *
 * There used to be a timer here, re-fetching every fifteen minutes and
 * re-advertising whatever changed. It was removed deliberately: a tool schema
 * that changes underneath a session in progress makes a call that was valid
 * when the agent composed it invalid by the time it is sent, and nothing about
 * Hermes changes often enough to pay for that. `hermes_refresh_openapi` remains
 * for the case where it genuinely has.
 *
 * Never rejects. A failed fetch leaves the registry on the bundled snapshot,
 * which is the property that makes removing the timer safe — this server has
 * never needed the network to be useful.
 *
 * `onRefreshed` runs only after a *successful* load, because its job is to
 * re-advertise schemas that actually changed. Running it on failure would
 * announce a refresh that did not happen.
 */
export const primeRegistry = async (
  registry: SchemaRegistry,
  config: PrimeConfig,
  logger: Logger,
  onRefreshed?: () => void
): Promise<void> => {
  try {
    const doc = await fetchOpenApiDoc(config.openApiDocsUrl, config.openApiFetchTimeoutMs);
    const stale = registry.refresh(doc, logger);
    onRefreshed?.();
    logger.info("openapi schema loaded", { stale: stale.length });
  } catch (err) {
    logger.warn("openapi schema fetch failed, keeping bundled snapshot", {
      error: errorMessage(err),
    });
  }
};
