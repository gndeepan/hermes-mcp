import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "../logging.js";
import type { HermesMcpConfig } from "../config.js";
import type { SchemaRegistry } from "../registry/schemaRegistry.js";
import type { CompiledEndpoint } from "../registry/schemaFromOpenApi.js";
import { ENDPOINTS } from "../registry/endpoints.js";
import type { Credentials, HermesRequester } from "../hermesClient.js";
import type { TokenManager } from "../auth/tokenManager.js";
import { fetchOpenApiDoc } from "../openapiSync.js";
import { HermesUnauthenticatedError, toToolResult, type ToolResult } from "../errors.js";

export interface ToolContext {
  config: HermesMcpConfig;
  logger: Logger;
  tokenManager: TokenManager;
  registry: SchemaRegistry;
  createClient: (credentials: Credentials) => HermesRequester;
}

interface BuiltRequest {
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

const buildRequest = (compiled: CompiledEndpoint, args: Record<string, unknown>): BuiltRequest => {
  let path = compiled.pathTemplate;
  const query: Record<string, string> = {};
  for (const [name, location] of Object.entries(compiled.paramLocations)) {
    const value = args[name];
    if (value === undefined) continue;
    if (location === "path") {
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    } else {
      query[name] = String(value);
    }
  }
  return { path, query, body: compiled.hasBody ? args.body : undefined };
};

type ToolReturn = ToolResult | { content: [{ type: "text"; text: string }] };

/**
 * The single seam where every cross-cutting concern lives: credential
 * resolution, the one-shot refresh-and-retry on a 401, tracing, timing, and
 * failure mapping. `HermesClient` stays a pure transport precisely so all of
 * this can live here, once.
 */
const wrap =
  (toolName: string, method: string, ctx: ToolContext) =>
  async (args: Record<string, unknown>): Promise<ToolReturn> => {
    const start = Date.now();
    const traceId = randomBytes(4).toString("hex");
    try {
      const compiled = ctx.registry.get(toolName);
      const { path, query, body } = buildRequest(compiled, args);
      const credentials = await ctx.tokenManager.getValidCredentials();

      ctx.logger.debug("tool call start", { tool: toolName, traceId, method, path, query });

      let data: unknown;
      try {
        data = await ctx.createClient(credentials).request(method, path, { query, body });
      } catch (err) {
        if (!(err instanceof HermesUnauthenticatedError)) throw err;
        ctx.logger.debug("tool call retrying after 401", { tool: toolName, traceId });
        const refreshed = await ctx.tokenManager.forceRefresh();
        data = await ctx.createClient(refreshed).request(method, path, { query, body });
      }

      ctx.logger.info("tool call ok", { tool: toolName, traceId, durationMs: Date.now() - start });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      ctx.logger.info("tool call failed", { tool: toolName, traceId, durationMs: Date.now() - start });
      return toToolResult(err, ctx.logger, toolName);
    }
  };

const REFRESH_TOOL = "hermes_refresh_openapi";

const registerRefreshTool = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    REFRESH_TOOL,
    {
      description:
        "Refresh every hermes_* tool's input schema from the live Hermes OpenAPI document, without waiting for the background interval. Returns how many tool schemas were recompiled and which ones actually changed.",
      inputSchema: z.object({}),
    },
    (async (): Promise<ToolReturn> => {
      const traceId = randomBytes(4).toString("hex");
      const before = new Map(
        ctx.registry.list().map((entry) => [entry.toolName, JSON.stringify(entry.paramLocations)])
      );
      try {
        const doc = await fetchOpenApiDoc(ctx.config.openApiDocsUrl, ctx.config.openApiFetchTimeoutMs);
        ctx.registry.refresh(doc, ctx.logger);
      } catch (err) {
        return toToolResult(err, ctx.logger, REFRESH_TOOL);
      }
      const entries = ctx.registry.list();
      const changed = entries
        .filter((entry) => JSON.stringify(entry.paramLocations) !== before.get(entry.toolName))
        .map((entry) => entry.toolName);
      ctx.logger.info("openapi schema refreshed on demand", {
        traceId,
        refreshed: entries.length,
        changed: changed.length,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ refreshed: entries.length, changed }) }],
      };
    }) as Parameters<typeof server.registerTool>[2]
  );
};

export const registerHermesTools = (server: McpServer, ctx: ToolContext): void => {
  for (const definition of ENDPOINTS) {
    const compiled = ctx.registry.get(definition.toolName);
    server.registerTool(
      definition.toolName,
      { description: definition.description, inputSchema: compiled.inputSchema },
      wrap(definition.toolName, definition.method, ctx) as Parameters<typeof server.registerTool>[2]
    );
  }
  registerRefreshTool(server, ctx);
};
