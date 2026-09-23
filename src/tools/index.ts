import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import type { Logger } from "../logging.js";
import type { HermesMcpConfig } from "../config.js";
import type { SchemaRegistry } from "../registry/schemaRegistry.js";
import type { CompiledEndpoint } from "../registry/schemaFromOpenApi.js";
import { ENDPOINTS } from "../registry/endpoints.js";
import { registerGatewayTools } from "./gateway.js";
import { OperationIndex } from "../registry/operations.js";
import type { HermesRequester } from "../hermesClient.js";
import { userContextFrom, type HttpCredentials, type UserContext } from "../userContext.js";
import { fetchOpenApiDoc, type PrimeTarget } from "../openapiSync.js";
import { isStale, type SessionTokens, type TokenCache } from "../tokenRefresh.js";
import {
  HermesUnauthenticatedError,
  InvalidPathParameterError,
  StoreMismatchError,
  toToolResult,
  type ToolResult,
} from "../errors.js";

export interface ToolContext {
  config: HermesMcpConfig;
  logger: Logger;
  registry: SchemaRegistry;
  createClient: (user: UserContext) => HermesRequester;
  /**
   * Credentials from the HTTP request being served, when there is one.
   *
   * Set by the HTTP entry, which builds a fresh server per request. Absent
   * under stdio, where there is no request to take a header from.
   */
  httpCredentials?: HttpCredentials;
  /**
   * Whether a call with no credentials of its own may fall back to the
   * environment.
   *
   * True for stdio, where one process serves one user by construction. False
   * for the shared HTTP service, where falling back would mean a request that
   * forgot its credentials silently acts as whatever merchant is in the
   * environment — a cross-tenant read that looks exactly like success.
   */
  allowEnvFallback?: boolean;
  /**
   * The process-wide store of renewed access tokens.
   *
   * Absent means renewal is off entirely and a rejected token is reported as a
   * rejected token — the behaviour this server had before renewal existed. A
   * call is renewed only if this is present *and* that call granted a refresh
   * token, so it takes both a configured server and a consenting caller.
   */
  tokens?: TokenCache;
  /**
   * The live specification views, held as a reference rather than copied.
   *
   * `hermes_refresh_openapi` *replaces* the operation index — an index cannot
   * be refreshed in place the way `SchemaRegistry` can — so a context holding
   * its own copy would keep answering from the document the server started
   * with, silently, for the rest of the process. Reading through the runtime is
   * what makes the manual refresh mean anything to the gateway.
   */
  specs: PrimeTarget;
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

export type ToolReturn = ToolResult | { content: [{ type: "text"; text: string }] };

/**
 * A call may only act on the store it authenticated as.
 *
 * Four tools take `storeId` as an argument that steers the path, while the
 * authenticated identity comes from the token. Nothing made the two agree.
 * Hermes would probably refuse the mismatch, but a tenant boundary cannot rest
 * on "probably" — and the cost of being wrong on a shared process is one
 * merchant reading another's blocks.
 *
 * Tools without a `storeId` argument are unaffected: the header alone decides
 * what they see.
 *
 * Takes the candidate ids rather than the argument bag because the gateway
 * nests them. A curated tool's `storeId` is a top-level argument; a
 * `hermes_call_api` call carries it inside `pathParams` or `body`, and reading
 * only the top level — as this did — would let a gateway call address another
 * merchant's store, authorised by the caller's own token and therefore
 * answering with data rather than an error.
 */
export const assertStoreIds = (candidates: unknown[], user: UserContext): void => {
  for (const named of candidates) {
    if (named === undefined || named === null) continue;

    const asText = typeof named === "number" ? String(named) : named;
    if (typeof asText !== "string" || asText === "") continue;
    if (asText !== user.storeId) throw new StoreMismatchError(asText, user.storeId);
  }
};

const assertActingOnOwnStore = (args: Record<string, unknown>, user: UserContext): void =>
  assertStoreIds([args.storeId], user);

/** How a renewal came to happen, for the log line. Never the tokens themselves. */
type RenewalReason = "expired" | "rejected";

/**
 * Runs one Hermes request, renewing the session around it when — and only
 * when — the caller granted a refresh token.
 *
 * This server still owns no credential of its own. What changed is that a
 * caller may now lend it one: a refresh token in `_meta` is explicit
 * permission to renew *that* session, and nothing else. A call without one
 * behaves exactly as this server always did, with a 401 surfaced unchanged.
 *
 * Two triggers, because one of them is not enough:
 *
 * - **Expiry**, from the caller's own `expiresAt`, so a known-dead token never
 *   costs a failed round trip in the first place.
 * - **Rejection**, because `expiresAt` is a claim and Hermes's 401 is a fact.
 *   Clocks drift, sessions get revoked, and a caller may not send an expiry at
 *   all.
 *
 * The retry happens exactly once. A second 401 is Hermes's answer about a
 * freshly minted token, and asking a third time only makes the merchant wait.
 * Retrying a non-idempotent call is safe here in a way a transport retry is
 * not: a 401 means Hermes refused the request before acting on it, so there is
 * no half-done write to duplicate.
 */
export const sendWithRenewal = async (
  ctx: ToolContext,
  user: UserContext,
  send: (acting: UserContext) => Promise<unknown>,
  onRenewal: (reason: RenewalReason) => void
): Promise<unknown> => {
  const cache = ctx.tokens;
  const refreshToken = user.refreshToken;
  if (cache === undefined || refreshToken === undefined) return send(user);

  let acting = user;
  if (user.expiresAt !== undefined && isStale({ ...user, refreshToken, expiresAt: user.expiresAt })) {
    acting = withTokens(user, await cache.accessTokenFor(refreshToken));
    onRenewal("expired");
  }

  try {
    return await send(acting);
  } catch (err) {
    if (!(err instanceof HermesUnauthenticatedError)) throw err;

    // Forced: the cached token is precisely the one Hermes just refused, so
    // handing it back would retry the same rejected request.
    const renewed = await cache.accessTokenFor(refreshToken, { force: true });
    // An identical token means the renewal changed nothing. Sending it again
    // asks Hermes the same question and gets the same answer.
    if (renewed.accessToken === acting.accessToken) throw err;

    onRenewal("rejected");
    return send(withTokens(user, renewed));
  }
};

/**
 * The same identity, carrying a renewed credential.
 *
 * `storeId` and `requestId` are copied from the original on purpose. Renewal
 * replaces a credential; it never changes who the call acts as or what it may
 * touch. Hermes's refresh response names a `userId` and a list of stores, and
 * letting either of those reach the request would let an auth response widen a
 * call's scope after `assertActingOnOwnStore` has already ruled on it.
 */
const withTokens = (user: UserContext, tokens: SessionTokens): UserContext => ({
  ...user,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  expiresAt: tokens.expiresAt,
});

/**
 * The single seam where every cross-cutting concern lives: resolving the
 * caller's identity from this call's `_meta`, session renewal, tracing, timing,
 * and failure mapping. `HermesClient` stays a pure transport precisely so all
 * of this can live here, once — renewal in particular has no business in a
 * class documented as holding no credential lifecycle.
 */
const wrap =
  (toolName: string, method: string, ctx: ToolContext) =>
  async (args: Record<string, unknown>, call: CallContext): Promise<ToolReturn> => {
    const start = Date.now();
    const traceId = randomBytes(4).toString("hex");
    try {
      const compiled = ctx.registry.get(toolName);
      const { path, query, body } = buildRequest(compiled, args);
      const user = userContextFrom(
        call?.mcpReq?._meta,
        ctx.httpCredentials,
        ctx.allowEnvFallback === false ? null : ctx.config.credentials
      );
      assertActingOnOwnStore(args, user);

      ctx.logger.debug("tool call start", {
        tool: toolName,
        traceId,
        method,
        path,
        query,
        storeId: user.storeId,
      });

      const data = await sendWithRenewal(
        ctx,
        user,
        (acting) => ctx.createClient(acting).request(method, path, { query, body }),
        (reason) => {
          // The reason, never the credential. `logging.ts` redacts token-shaped
          // keys, but the surest way not to log a secret is not to pass one.
          ctx.logger.info("renewed hermes session", { tool: toolName, traceId, reason });
        }
      );

      ctx.logger.info("tool call ok", { tool: toolName, traceId, durationMs: Date.now() - start });
      // See gateway.ts: an empty Hermes body would otherwise leave `text`
      // undefined and make the result invalid against the MCP schema.
      return { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
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
        "Recompile every other hermes_* tool's input schema from Hermes's live OpenAPI document, which this server reads once at startup and does not poll. Takes no arguments and touches no store data — it only re-reads the API specification, so it is safe to call at any time. Returns how many tool schemas were recompiled, the names of the ones that actually changed, and `stale`: tools whose operation is no longer in the specification and which are therefore still advertising the last schema that compiled. Any change is re-advertised to you immediately, so re-read the tool list afterwards. A tool listed in `stale` may fail at Hermes however correctly you call it. Reach for this when a hermes_* call is rejected for an argument you believe is correct, which can mean Hermes has changed that endpoint since this server started. It cannot add or remove tools — only the allowlisted operations exist, whatever the specification says.",
      inputSchema: z.object({}),
    },
    (async (): Promise<ToolReturn> => {
      const traceId = randomBytes(4).toString("hex");
      let changed: string[];
      let stale: string[];
      let refreshed: number;
      let operations: number;
      try {
        const doc = await fetchOpenApiDoc(ctx.config.openApiDocsUrl, ctx.config.openApiFetchTimeoutMs);
        stale = ctx.registry.refresh(doc, ctx.logger);
        // The gateway's view moves with the allowlist's. Refreshing one and not
        // the other would leave hermes_find_api describing operations the
        // curated tools no longer agree exist.
        ctx.specs.operations = OperationIndex.fromDocument(doc);
        ctx.specs.doc = doc;
        operations = ctx.specs.operations.size;
        changed = syncToolSchemas();
        refreshed = ctx.registry.list().length;
      } catch (err) {
        return toToolResult(err, ctx.logger, REFRESH_TOOL);
      }
      ctx.logger.info("openapi schema refreshed on demand", {
        traceId,
        refreshed,
        changed: changed.length,
        stale: stale.length,
        operations,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ refreshed, changed, stale, operations }) }],
      };
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
  // Last, so the curated tools are listed first. A model reading tools/list
  // top-down meets the well-described, purpose-built tools before the
  // catch-all, which is the order we want it to prefer them in.
  registerGatewayTools(server, ctx, { sendWithRenewal, assertStoreIds });

  return syncToolSchemas;
};
