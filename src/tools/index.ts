import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import type { Logger } from "../logging.js";
import type { HermesMcpConfig } from "../config.js";
import type { SchemaRegistry } from "../registry/schemaRegistry.js";
import type { CompiledEndpoint } from "../registry/schemaFromOpenApi.js";
import { ENDPOINTS } from "../registry/endpoints.js";
import type { Credentials, HermesRequester } from "../hermesClient.js";
import type { TokenManager } from "../auth/tokenManager.js";
import { fetchOpenApiDoc } from "../openapiSync.js";
import {
  HermesUnauthenticatedError,
  InvalidPathParameterError,
  toToolResult,
  type ToolResult,
} from "../errors.js";

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

/**
 * A dot-only path-param value survives `encodeURIComponent` untouched, and
 * `new URL(path, base)` in `HermesClient` then applies RFC-3986 dot-segment
 * removal — so `storeId: ".."` turns `/api/v1/stores/{storeId}/custom-blocks`
 * into `/api/v1/custom-blocks`, an operation this server never allowlisted
 * (hard constraint #3). Dots are legal inside real Hermes ids, so only a value
 * consisting *entirely* of dots is refused.
 */
const DOT_ONLY = /^\.+$/;
const UNSUBSTITUTED_PLACEHOLDER = /\{[^}]+\}/;

/**
 * The single check standing between caller input and the wire. Runs once, after
 * substitution, and covers both ways a path can stop being the allowlisted one:
 * a value that resolves the path away, and a placeholder left behind because a
 * live refresh dropped the parameter that used to fill it.
 */
const assertAllowlistedPath = (compiled: CompiledEndpoint, path: string): void => {
  const leftover = UNSUBSTITUTED_PLACEHOLDER.exec(path);
  if (leftover) {
    throw new InvalidPathParameterError(
      compiled.pathTemplate,
      `the path parameter ${leftover[0]} is not declared by the current OpenAPI schema for this operation, so it cannot be filled in`
    );
  }
};

const buildRequest = (compiled: CompiledEndpoint, args: Record<string, unknown>): BuiltRequest => {
  let path = compiled.pathTemplate;
  const query: Record<string, string> = {};
  for (const [name, location] of Object.entries(compiled.paramLocations)) {
    const value = args[name];
    if (value === undefined) continue;
    if (location === "path") {
      const raw = String(value);
      if (DOT_ONLY.test(raw)) {
        throw new InvalidPathParameterError(
          compiled.pathTemplate,
          `"${name}" must not be a dot-only value like "." or ".." — it would resolve the request onto a different, non-allowlisted path`
        );
      }
      path = path.replace(`{${name}}`, encodeURIComponent(raw));
    } else {
      query[name] = String(value);
    }
  }
  assertAllowlistedPath(compiled, path);
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

/**
 * Re-advertises every allowlisted tool's input schema from the registry and
 * returns the names whose advertised schema genuinely changed.
 *
 * `SchemaRegistry.refresh` only replaces entries in its own map; the MCP server
 * holds whatever schema it was handed at registration. Without this, a live
 * refresh changes nothing a client can see — `tools/list` keeps advertising the
 * startup schema and the SDK keeps validating calls against it, so a
 * newly-required param is stripped before it can reach `buildRequest`.
 */
export type SyncToolSchemas = () => string[];

/**
 * The comparand for "did this schema change". `z.toJSONSchema` renders the
 * whole compiled shape — param names, types, enums, descriptions and
 * required-ness — so a change to any of them is caught, unlike the
 * `paramLocations`-only diff this replaces (which saw a param's location but
 * not its type, enum, or optionality).
 */
const schemaFingerprint = (compiled: CompiledEndpoint): string =>
  JSON.stringify(z.toJSONSchema(compiled.inputSchema, { io: "input" }));

const registerRefreshTool = (
  server: McpServer,
  ctx: ToolContext,
  syncToolSchemas: SyncToolSchemas
): void => {
  server.registerTool(
    REFRESH_TOOL,
    {
      description:
        "Refresh every hermes_* tool's input schema from the live Hermes OpenAPI document, without waiting for the background interval. Returns how many tool schemas were recompiled and which ones actually changed.",
      inputSchema: z.object({}),
    },
    (async (): Promise<ToolReturn> => {
      const traceId = randomBytes(4).toString("hex");
      let changed: string[];
      let refreshed: number;
      try {
        const doc = await fetchOpenApiDoc(ctx.config.openApiDocsUrl, ctx.config.openApiFetchTimeoutMs);
        ctx.registry.refresh(doc, ctx.logger);
        changed = syncToolSchemas();
        refreshed = ctx.registry.list().length;
      } catch (err) {
        return toToolResult(err, ctx.logger, REFRESH_TOOL);
      }
      ctx.logger.info("openapi schema refreshed on demand", {
        traceId,
        refreshed,
        changed: changed.length,
      });
      return { content: [{ type: "text", text: JSON.stringify({ refreshed, changed }) }] };
    }) as Parameters<typeof server.registerTool>[2]
  );
};

export const registerHermesTools = (server: McpServer, ctx: ToolContext): SyncToolSchemas => {
  const handles = new Map<string, RegisteredTool>();
  /** Fingerprint of the schema each tool is *currently advertising*, not the registry's. */
  const advertised = new Map<string, string>();

  for (const definition of ENDPOINTS) {
    const compiled = ctx.registry.get(definition.toolName);
    handles.set(
      definition.toolName,
      server.registerTool(
        definition.toolName,
        { description: definition.description, inputSchema: compiled.inputSchema },
        wrap(definition.toolName, definition.method, ctx) as Parameters<typeof server.registerTool>[2]
      )
    );
    advertised.set(definition.toolName, schemaFingerprint(compiled));
  }

  const syncToolSchemas: SyncToolSchemas = () => {
    const changed: string[] = [];
    for (const definition of ENDPOINTS) {
      const compiled = ctx.registry.get(definition.toolName);
      const fingerprint = schemaFingerprint(compiled);
      if (fingerprint === advertised.get(definition.toolName)) continue;
      advertised.set(definition.toolName, fingerprint);
      // Assigns the new input schema, regenerates the SDK's validating
      // executor, and notifies connected clients via tools/list_changed.
      handles.get(definition.toolName)?.update({ paramsSchema: compiled.inputSchema });
      changed.push(definition.toolName);
    }
    return changed;
  };

  registerRefreshTool(server, ctx, syncToolSchemas);
  return syncToolSchemas;
};
