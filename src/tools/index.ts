import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import type { Logger } from "../logging.js";
import type { HermesMcpConfig } from "../config.js";
import type { SchemaRegistry } from "../registry/schemaRegistry.js";
import type { CompiledEndpoint } from "../registry/schemaFromOpenApi.js";
import { ENDPOINTS } from "../registry/endpoints.js";
import type { HermesRequester } from "../hermesClient.js";
import { userContextFrom, type UserContext } from "../userContext.js";
import { fetchOpenApiDoc } from "../openapiSync.js";
import { InvalidPathParameterError, toToolResult, type ToolResult } from "../errors.js";

export interface ToolContext {
  config: HermesMcpConfig;
  logger: Logger;
  registry: SchemaRegistry;
  createClient: (user: UserContext) => HermesRequester;
}

/**
 * The slice of the MCP SDK's per-request context this server uses: the `_meta`
 * the client attached to *this* `tools/call`, which is where the caller's
 * Hermes credentials arrive. Declared structurally rather than imported so the
 * handlers stay unit-testable without standing up a transport.
 */
export interface CallContext {
  mcpReq?: { _meta?: Record<string, unknown> };
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
const DOT_ONLY_SEGMENT = /(^|\/)\.+(\/|$)/;

/**
 * The single check standing between a built path and the wire. Runs once, after
 * substitution, and covers both ways a path can stop being the allowlisted one:
 * a dot-only segment that `new URL()` would resolve away, and a placeholder
 * left behind because a live refresh dropped the parameter that used to fill
 * it. The per-parameter check in `buildRequest` catches the first case with a
 * message naming the offending parameter; this is the backstop that holds
 * whatever the substitution produced.
 */
const assertAllowlistedPath = (compiled: CompiledEndpoint, path: string): void => {
  const leftover = UNSUBSTITUTED_PLACEHOLDER.exec(path);
  if (leftover) {
    throw new InvalidPathParameterError(
      compiled.pathTemplate,
      `the path parameter ${leftover[0]} is not declared by the current OpenAPI schema for this operation, so it cannot be filled in`
    );
  }
  if (DOT_ONLY_SEGMENT.test(path)) {
    throw new InvalidPathParameterError(
      compiled.pathTemplate,
      "the resulting path contains a dot-only segment, which would resolve onto a different, non-allowlisted path"
    );
  }
};

export const buildRequest = (
  compiled: CompiledEndpoint,
  args: Record<string, unknown>
): BuiltRequest => {
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
  // Hermes rejects a paged list with no page as 404, not 400, so an omitted
  // page looks like "this store has no custom blocks" rather than like a
  // malformed request. The published schema marks page required, but the
  // live-refreshed one does not always agree, and a list call wants the first
  // page in every case — so supply it rather than depend on which spec won.
  if (compiled.paramLocations.page === "query" && query.page === undefined) {
    query.page = "1";
  }

  assertAllowlistedPath(compiled, path);
  return { path, query, body: compiled.hasBody ? args.body : undefined };
};

type ToolReturn = ToolResult | { content: [{ type: "text"; text: string }] };

/**
 * The single seam where every cross-cutting concern lives: resolving the
 * caller's identity from this call's `_meta`, tracing, timing, and failure
 * mapping. `HermesClient` stays a pure transport precisely so all of this can
 * live here, once.
 *
 * There is no refresh-and-retry: this server owns no credential and cannot
 * mint a new one, so a 401 is the caller's own session being rejected and is
 * surfaced to them unchanged — the same contract the AI Server's `HermesClient`
 * keeps.
 */
const wrap =
  (toolName: string, method: string, ctx: ToolContext) =>
  async (args: Record<string, unknown>, call: CallContext): Promise<ToolReturn> => {
    const start = Date.now();
    const traceId = randomBytes(4).toString("hex");
    try {
      const compiled = ctx.registry.get(toolName);
      const { path, query, body } = buildRequest(compiled, args);
      const user = userContextFrom(call?.mcpReq?._meta, ctx.config.credentials);

      ctx.logger.debug("tool call start", {
        tool: toolName,
        traceId,
        method,
        path,
        query,
        storeId: user.storeId,
      });

      const data = await ctx.createClient(user).request(method, path, { query, body });

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
        "Recompile every other hermes_* tool's input schema from Hermes's live OpenAPI document, without waiting for the background refresh interval. Takes no arguments and touches no store data — it only re-reads the API specification, so it is safe to call at any time. Returns how many tool schemas were recompiled and the names of the ones that actually changed; any change is also re-advertised to you immediately, so re-read the tool list afterwards. Reach for this when a hermes_* call is rejected for an argument you believe is correct, which can mean Hermes has changed that endpoint since this server started. It cannot add or remove tools — only the allowlisted operations exist, whatever the specification says.",
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
