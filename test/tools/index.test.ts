import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { ENDPOINTS } from "../../src/registry/endpoints.js";
import { createLogger } from "../../src/logging.js";
import { loadConfig } from "../../src/config.js";
import type { HermesRequester } from "../../src/hermesClient.js";
import type { OpenApiDocument } from "../../src/registry/schemaFromOpenApi.js";
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesUnauthenticatedError,
  SessionExpiredError,
} from "../../src/errors.js";
import {
  ACCESS_TOKEN_KEY,
  EXPIRES_AT_KEY,
  REFRESH_TOKEN_KEY,
  REQUEST_ID_KEY,
  STORE_ID_KEY,
} from "../../src/userContext.js";
import type { SessionTokens, TokenCache } from "../../src/tokenRefresh.js";
import { buildRequest } from "../../src/tools/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What a well-behaved client attaches to every tools/call. */
const CREDENTIAL_META = { [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "s1" };

const buildServerAndClient = async (ctx: ToolContext): Promise<Client> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHermesTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const baseCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  config: loadConfig({}),
  logger: createLogger({ logLevel: "silent" }),
  registry: SchemaRegistry.fromDocument(loadSnapshotDoc()),
  createClient: () => ({ request: vi.fn() }) as HermesRequester,
  ...overrides,
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

/** Like `buildServerAndClient`, but also hands back the schema-sync function. */
const buildWithSync = async (
  ctx: ToolContext
): Promise<{ client: Client; syncToolSchemas: () => string[] }> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const syncToolSchemas = registerHermesTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, syncToolSchemas };
};

const advertisedSchema = async (client: Client, name: string): Promise<Record<string, unknown>> => {
  const tool = (await client.listTools()).tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not advertised`);
  return tool.inputSchema as unknown as Record<string, unknown>;
};

/** The snapshot, with `hermes_get_widget` having gained a required query param. */
const docWithNewRequiredWidgetParam = (): OpenApiDocument => {
  const doc = loadSnapshotDoc();
  const operation = doc.paths["/api/v1/widgets/{id}"].get!;
  operation.parameters = [
    ...(operation.parameters ?? []),
    { name: "revision", in: "query", required: true, schema: { type: "string" } },
  ];
  return doc;
};

describe("registerHermesTools", () => {
  it("registers every allowlisted tool plus hermes_refresh_openapi", async () => {
    const client = await buildServerAndClient(baseCtx());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...ENDPOINTS.map((e) => e.toolName), "hermes_refresh_openapi"].sort()
    );
  });

  it("calls the injected client with the substituted path and returns its result as text", async () => {
    const request = vi.fn(async () => ({ id: "w1", display: true }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({ _meta: CREDENTIAL_META, name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/widgets/w1", { query: {}, body: undefined });
    expect(JSON.parse(textOf(result))).toEqual({ id: "w1", display: true });
  });

  it("returns MISSING_CREDENTIALS and never calls Hermes when the call carries no _meta", async () => {
    const request = vi.fn();
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns MISSING_CREDENTIALS when _meta carries a token but no store id", async () => {
    const request = vi.fn();
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "t" },
      name: "hermes_get_widget",
      arguments: { id: "w1" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(request).not.toHaveBeenCalled();
  });

  it("builds the client from this call's own _meta, not from any process-wide state", async () => {
    const request = vi.fn(async () => ({ id: "w1" }));
    const seen: unknown[] = [];
    const client = await buildServerAndClient(
      baseCtx({
        createClient: (user) => {
          seen.push(user);
          return { request };
        },
      })
    );

    await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "token-a", [STORE_ID_KEY]: "store-a", [REQUEST_ID_KEY]: "req-a" },
      name: "hermes_get_widget",
      arguments: { id: "w1" },
    });
    await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "token-b", [STORE_ID_KEY]: "store-b" },
      name: "hermes_get_widget",
      arguments: { id: "w1" },
    });

    expect(seen).toEqual([
      { accessToken: "token-a", storeId: "store-a", requestId: "req-a" },
      { accessToken: "token-b", storeId: "store-b" },
    ]);
  });

  it("falls back to the env-var credential only when the call carries none", async () => {
    const request = vi.fn(async () => ({ id: "w1" }));
    const seen: unknown[] = [];
    const client = await buildServerAndClient(
      baseCtx({
        config: loadConfig({ HERMES_ACCESS_TOKEN: "env-token", HERMES_STORE_ID: "env-store" }),
        createClient: (user) => {
          seen.push(user);
          return { request };
        },
      })
    );

    await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });
    await client.callTool({ _meta: CREDENTIAL_META, name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(seen).toEqual([
      { accessToken: "env-token", storeId: "env-store" },
      { accessToken: "t", storeId: "s1" },
    ]);
  });

  it("separates path params from query params for hermes_list_custom_blocks", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_list_custom_blocks",
      arguments: { storeId: "s1", page: 1, contentType: "HTML" },
    });

    expect(request).toHaveBeenCalledWith("get", "/api/v1/stores/s1/custom-blocks", {
      query: { page: "1", contentType: "HTML" },
      body: undefined,
    });
  });

  it("passes the body field through for a create tool", async () => {
    const request = vi.fn(async () => ({ id: "cb1" }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));
    const body = {
      name: "n",
      type: "FULLSCREEN",
      contentType: "HTML",
      segregationType: "HOME",
      content: "<div></div>",
    };

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_create_custom_block",
      arguments: { storeId: "s1", body },
    });

    expect(request).toHaveBeenCalledWith("post", "/api/v1/stores/s1/custom-blocks", { query: {}, body });
  });

  it("surfaces a rejected Hermes call as a visible, coded error", async () => {
    const request = vi.fn(async () => {
      throw new HermesNotFoundError("/api/v1/widgets/missing");
    });
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({ _meta: CREDENTIAL_META, name: "hermes_get_widget", arguments: { id: "missing" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
  });

  it("surfaces a 401 without retrying when the caller granted no refresh token", async () => {
    // Without a refresh token this server still cannot mint one, so a rejected
    // session is the caller's answer to act on rather than something to paper
    // over. See the renewal suite below for what changes when they grant one.
    const request = vi.fn(async () => {
      throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
    });
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_get_widget",
      arguments: { id: "w1" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNAUTHENTICATED");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("logs a debug line and an info line sharing one traceId per call", async () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));
    const request = vi.fn(async () => ({ id: "w1" }));
    const client = await buildServerAndClient(baseCtx({ logger, createClient: () => ({ request }) }));

    await client.callTool({ _meta: CREDENTIAL_META, name: "hermes_get_widget", arguments: { id: "w1" } });

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = parsed.find((p) => p.message === "tool call start");
    const ok = parsed.find((p) => p.message === "tool call ok");
    expect(start?.traceId).toBeTypeOf("string");
    expect(ok?.traceId).toBe(start?.traceId);
    expect(start?.path).toBe("/api/v1/widgets/w1");
    expect(start?.method).toBe("get");
  });

  it("hermes_refresh_openapi reports the refreshed count and which tools changed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const doc = loadSnapshotDoc();
        doc.paths["/api/v1/widgets/{id}"].get!.parameters = [];
        return new Response(JSON.stringify(doc), { status: 200 });
      })
    );
    const client = await buildServerAndClient(baseCtx());

    const result = await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result)) as { refreshed: number; changed: string[] };
    expect(parsed.refreshed).toBe(ENDPOINTS.length);
    expect(parsed.changed).toContain("hermes_get_widget");
  });

  it("re-advertises a newly required param to the client and lets a call carry it through", async () => {
    const request = vi.fn(async () => ({ id: "w1" }));
    const ctx = baseCtx({ createClient: () => ({ request }) });
    const { client, syncToolSchemas } = await buildWithSync(ctx);

    const before = await advertisedSchema(client, "hermes_get_widget");
    expect(Object.keys((before.properties ?? {}) as object)).not.toContain("revision");

    ctx.registry.refresh(docWithNewRequiredWidgetParam(), ctx.logger);
    expect(syncToolSchemas()).toContain("hermes_get_widget");

    const after = await advertisedSchema(client, "hermes_get_widget");
    expect(Object.keys((after.properties ?? {}) as object)).toContain("revision");
    expect(after.required).toContain("revision");

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_get_widget",
      arguments: { id: "w1", revision: "v2" },
    });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/widgets/w1", {
      query: { revision: "v2" },
      body: undefined,
    });
  });

  it("reports no change and re-advertises nothing when a refresh brings an identical document", async () => {
    const ctx = baseCtx();
    const { syncToolSchemas } = await buildWithSync(ctx);
    ctx.registry.refresh(loadSnapshotDoc(), ctx.logger);
    expect(syncToolSchemas()).toEqual([]);
  });

  it("hermes_refresh_openapi counts a param whose type changed as changed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const doc = loadSnapshotDoc();
        doc.paths["/api/v1/widgets/{id}"].get!.parameters = [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
        ];
        return new Response(JSON.stringify(doc), { status: 200 });
      })
    );
    const client = await buildServerAndClient(baseCtx());

    const result = await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });

    const parsed = JSON.parse(textOf(result)) as { changed: string[] };
    expect(parsed.changed).toContain("hermes_get_widget");
  });

  it.each(["..", ".", "..."])(
    "refuses %s as a path param instead of issuing a truncated path",
    async (storeId) => {
      const request = vi.fn(async () => ({ id: "cb1" }));
      const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

      const result = await client.callTool({
      _meta: CREDENTIAL_META,
        name: "hermes_create_custom_block",
        arguments: { storeId, body: { name: "n" } },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INVALID_PATH_PARAM");
      expect(request).not.toHaveBeenCalled();
    }
  );

  it("keeps a literal {placeholder} value inside its own path segment", async () => {
    // Asserted on `id` rather than `storeId`: a call may only ever name the
    // store it authenticated as, so a literal "{storeId}" is now refused before
    // it can reach the path builder. The encoding property is the same either
    // way, and testing it on a non-tenant parameter keeps the two rules from
    // masking each other.
    const request = vi.fn(async () => ({ id: "b1" }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_get_custom_block",
      arguments: { storeId: "s1", id: "{id}" },
    });

    const [, calledPath] = request.mock.calls[0] as unknown as [string, string];
    expect(calledPath).toBe("/api/v1/stores/s1/custom-blocks/%7Bid%7D");
    expect(calledPath).not.toMatch(/\{[^}]+\}/);
  });

  it("refuses a dot-only segment however it got into the built path", async () => {
    // Backstop for the per-parameter check: the guard holds on the built path.
    const request = vi.fn(async () => ({ id: "w1" }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_get_custom_block",
      arguments: { storeId: "s1", id: ".." },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INVALID_PATH_PARAM");
    expect(request).not.toHaveBeenCalled();
  });

  it("never issues a request whose path still holds an unsubstituted placeholder", async () => {
    const request = vi.fn(async () => ({ id: "w1" }));
    const ctx = baseCtx({ createClient: () => ({ request }) });
    const { client, syncToolSchemas } = await buildWithSync(ctx);

    // A live refresh in which hermes_update_widget lost its `id` path param.
    const doc = loadSnapshotDoc();
    doc.paths["/api/v1/widgets/{id}"].put!.parameters = [];
    ctx.registry.refresh(doc, ctx.logger);
    syncToolSchemas();

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_update_widget",
      arguments: { body: { display: true } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INVALID_PATH_PARAM");
    expect(request).not.toHaveBeenCalled();
  });

  it("hermes_refresh_openapi surfaces a fetch failure as an error result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const client = await buildServerAndClient(baseCtx());

    const result = await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });

    expect(result.isError).toBe(true);
  });
});

describe("paged list endpoints", () => {
  it("sends page 1 when the caller omits it", async () => {
    // Hermes answers a paged list with no page as 404, not 400, so an omitted
    // page reads as "this store has no blocks" rather than as a bad request.
    const compiled = {
      pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
      paramLocations: { storeId: "path", page: "query" },
      hasBody: false,
    } as never;

    const { query } = buildRequest(compiled, { storeId: "1234" });
    expect(query.page).toBe("1");
  });

  it("keeps the page the caller asked for", () => {
    const compiled = {
      pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
      paramLocations: { storeId: "path", page: "query" },
      hasBody: false,
    } as never;

    const { query } = buildRequest(compiled, { storeId: "1234", page: 3 });
    expect(query.page).toBe("3");
  });

  it("adds no page to an endpoint that does not take one", () => {
    const compiled = {
      pathTemplate: "/api/v1/stores/{storeId}/themes/active",
      paramLocations: { storeId: "path" },
      hasBody: false,
    } as never;

    const { query } = buildRequest(compiled, { storeId: "1234" });
    expect("page" in query).toBe(false);
  });
});

/**
 * The properties a shared, multi-user process rests on.
 *
 * None of these mattered while one process served one merchant over stdio. All
 * of them matter the moment a single process answers for many, and each one
 * fails by returning somebody else's data rather than by erroring — which is
 * why they are asserted rather than reasoned about.
 */
describe("serving more than one merchant", () => {
  it("keeps concurrent calls with different credentials isolated", async () => {
    // The headline property. Interleaved on purpose: a client cached anywhere
    // between the two would show up as one identity serving both calls.
    const seen: unknown[] = [];
    const request = vi.fn(async () => ({ ok: true }));
    const client = await buildServerAndClient(
      baseCtx({
        createClient: (user) => {
          seen.push({ ...user });
          return { request };
        },
      })
    );

    await Promise.all([
      client.callTool({
        _meta: { [ACCESS_TOKEN_KEY]: "token-a", [STORE_ID_KEY]: "store-a" },
        name: "hermes_get_active_theme",
        arguments: {},
      }),
      client.callTool({
        _meta: { [ACCESS_TOKEN_KEY]: "token-b", [STORE_ID_KEY]: "store-b" },
        name: "hermes_get_active_theme",
        arguments: {},
      }),
    ]);

    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual({ accessToken: "token-a", storeId: "store-a" });
    expect(seen).toContainEqual({ accessToken: "token-b", storeId: "store-b" });
  });

  it("refuses a call naming a store it did not authenticate as", async () => {
    // `storeId` arrives twice — as the argument steering the path, and as the
    // identity behind the token. Nothing used to make them agree.
    const request = vi.fn();
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "token-a", [STORE_ID_KEY]: "store-a" },
      name: "hermes_get_custom_block",
      arguments: { storeId: "store-b", id: "cbk_1" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("STORE_MISMATCH");
    expect(request).not.toHaveBeenCalled();
  });

  it("allows the call when the named store is the authenticated one", async () => {
    const request = vi.fn(async () => ({ id: "cbk_1" }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "token-a", [STORE_ID_KEY]: "store-a" },
      name: "hermes_get_custom_block",
      arguments: { storeId: "store-a", id: "cbk_1" },
    });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalled();
  });

  it("compares a numeric store id by value, not by type", async () => {
    // The MCP Inspector JSON-parses `--tool-metadata storeId=1234` into a
    // number, so `_meta` carries 1234 while the argument is the string the
    // tool schema requires. A strict comparison would refuse a caller acting
    // entirely legitimately.
    const request = vi.fn(async () => ({ items: [] }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: 1234 },
      name: "hermes_list_custom_blocks",
      arguments: { storeId: "1234", page: 1 },
    });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalled();
  });

  it("refuses an uncredentialled call when the env fallback is off", async () => {
    // The hazard this closes: on a shared process a leftover HERMES_ACCESS_TOKEN
    // would silently serve that merchant's data to a request that brought none,
    // and the reply would look exactly like a successful one.
    const request = vi.fn();
    const client = await buildServerAndClient(
      baseCtx({
        config: loadConfig({ HERMES_ACCESS_TOKEN: "env-token", HERMES_STORE_ID: "env-store" }),
        allowEnvFallback: false,
        createClient: () => ({ request }),
      })
    );

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(request).not.toHaveBeenCalled();
  });

  it("prefers the HTTP credential over anything the call carries in _meta", async () => {
    // A bearer token on the request is the caller's real identity. `_meta` is
    // in-band and must never be able to talk over it.
    const seen: unknown[] = [];
    const request = vi.fn(async () => ({ ok: true }));
    const client = await buildServerAndClient(
      baseCtx({
        httpCredentials: { accessToken: "http-token", storeId: "http-store" },
        allowEnvFallback: false,
        createClient: (user) => {
          seen.push({ ...user });
          return { request };
        },
      })
    );

    await client.callTool({
      _meta: { [ACCESS_TOKEN_KEY]: "meta-token", [STORE_ID_KEY]: "meta-store" },
      name: "hermes_get_active_theme",
      arguments: {},
    });

    expect(seen).toEqual([{ accessToken: "http-token", storeId: "http-store" }]);
  });
});

/**
 * What a refresh does when the API definition actually changes.
 *
 * The three cases are not symmetric and the asymmetry is the design, not an
 * oversight: a *modified* operation flows through automatically, an *added*
 * one deliberately does not, and a *removed* one degrades rather than
 * disappearing. Written down as tests because "does refreshing pick up API
 * changes?" has a different answer for each, and the answer to two of them is
 * no.
 */
describe("when Hermes changes its API", () => {
  const docServing = (mutate: (doc: ReturnType<typeof loadSnapshotDoc>) => void) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const doc = loadSnapshotDoc();
        mutate(doc);
        return new Response(JSON.stringify(doc), { status: 200 });
      })
    );

  const refresh = async (): Promise<{ refreshed: number; changed: string[]; stale: string[] }> => {
    const client = await buildServerAndClient(baseCtx());
    const result = await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });
    expect(result.isError).toBeFalsy();
    return JSON.parse(textOf(result)) as { refreshed: number; changed: string[]; stale: string[] };
  };

  describe("an operation is modified", () => {
    it("recompiles that tool's schema and says which one moved", async () => {
      docServing((doc) => {
        doc.paths["/api/v1/widgets/{id}"].get!.parameters = [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "locale", in: "query", required: false, schema: { type: "string" } },
        ];
      });

      const { changed, stale } = await refresh();

      expect(changed).toEqual(["hermes_get_widget"]);
      expect(stale).toEqual([]);
    });

    it("leaves every other tool alone", async () => {
      docServing((doc) => {
        doc.paths["/api/v1/widgets/{id}"].get!.parameters = [];
      });

      const { changed } = await refresh();

      expect(changed).not.toContain("hermes_get_active_theme");
      expect(changed).not.toContain("hermes_create_custom_block");
    });
  });

  describe("an operation is added", () => {
    it("does not become a tool, because the allowlist is the authority boundary", async () => {
      // The obvious expectation is that a new endpoint shows up as a new tool.
      // It must not. ENDPOINTS is what this server will ever call; if a path
      // appearing in a document Hermes serves could grant this server reach,
      // then whoever can edit that document decides what an agent may do to a
      // merchant's store. Adding a tool stays a reviewed code change.
      docServing((doc) => {
        doc.paths["/api/v1/discounts"] = {
          get: { operationId: "listDiscounts", parameters: [], responses: {} },
        } as never;
      });

      const { refreshed, changed } = await refresh();

      expect(refreshed).toBe(ENDPOINTS.length);
      expect(changed).toEqual([]);
    });

    it("still advertises exactly the allowlisted tools afterwards", async () => {
      docServing((doc) => {
        doc.paths["/api/v1/discounts"] = {
          get: { operationId: "listDiscounts", parameters: [], responses: {} },
        } as never;
      });
      const client = await buildServerAndClient(baseCtx());
      await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toHaveLength(ENDPOINTS.length + 1); // + hermes_refresh_openapi
      expect(names).not.toContain("hermes_list_discounts");
    });
  });

  describe("an operation is removed", () => {
    it("names the tool as stale rather than failing the whole refresh", async () => {
      docServing((doc) => {
        delete doc.paths["/api/v1/widgets/{id}"];
      });

      const { refreshed, stale } = await refresh();

      // Both tools on that path, because a path carries every verb: the GET
      // and the PUT go stale together. The rest still refreshed — one path
      // disappearing from a document, which also happens when a fetch returns
      // a truncated or wrong-environment spec, must not take the server down.
      expect(refreshed).toBe(ENDPOINTS.length);
      expect(stale.sort()).toEqual(["hermes_get_widget", "hermes_update_widget"]);
    });

    it("keeps the tool callable on its last-known-good schema", async () => {
      // Deliberate. A removal we cannot distinguish from a bad fetch should
      // degrade, not delete: dropping the tool would break a working agent on
      // the strength of one unreliable document. `stale` is how someone finds
      // out it is living on borrowed time.
      const request = vi.fn(async () => ({ id: "w1" }));
      const ctx = baseCtx({ createClient: () => ({ request }) });
      const { client } = await buildWithSync(ctx);

      ctx.registry.refresh({ paths: {} }, ctx.logger);

      const result = await client.callTool({
        _meta: CREDENTIAL_META,
        name: "hermes_get_widget",
        arguments: { id: "w1" },
      });

      expect(result.isError).toBeFalsy();
      expect(request).toHaveBeenCalledWith("get", "/api/v1/widgets/w1", {
        query: {},
        body: undefined,
      });
    });

    it("reports every tool as stale when the document is empty", async () => {
      docServing((doc) => {
        doc.paths = {};
      });

      const { stale } = await refresh();
      expect(stale).toHaveLength(ENDPOINTS.length);
    });
  });
});

describe("session renewal", () => {
  /** What a client sends once it is willing to have its session renewed here. */
  const RENEWABLE_META = { ...CREDENTIAL_META, [REFRESH_TOKEN_KEY]: "r1" };

  const minted = (n: number): SessionTokens => ({
    accessToken: `fresh-${n}`,
    refreshToken: `r${n + 1}`,
    expiresAt: Date.now() + 3_600_000,
  });

  /**
   * A stand-in for the real cache. Records which token it was asked for and
   * whether the ask was forced, so these tests assert on the renewal decision
   * rather than on HTTP traffic — `test/tokenRefresh.test.ts` owns the traffic.
   */
  const fakeCache = (
    mint: (n: number) => SessionTokens = minted
  ): { calls: { refreshToken: string; force: boolean }[]; cache: TokenCache } => {
    let n = 0;
    const calls: { refreshToken: string; force: boolean }[] = [];
    const cache = {
      accessTokenFor: async (refreshToken: string, options: { force?: boolean } = {}) => {
        calls.push({ refreshToken, force: options.force === true });
        return mint((n += 1));
      },
    } as unknown as TokenCache;
    return { calls, cache };
  };

  /** A client factory that records which access token each attempt carried. */
  const tokensSeen = (): { seen: string[]; createClient: ToolContext["createClient"] } => {
    const seen: string[] = [];
    return {
      seen,
      createClient: (user) => {
        seen.push(user.accessToken);
        return { request: async () => ({ ok: true }) };
      },
    };
  };

  const callWidget = (client: Client, meta: Record<string, unknown>) =>
    client.callTool({ _meta: meta, name: "hermes_get_widget", arguments: { id: "w1" } });

  it("renews before the call when the token is already past its expiry", async () => {
    const { cache, calls } = fakeCache();
    const { seen, createClient } = tokensSeen();
    const client = await buildServerAndClient(baseCtx({ createClient, tokens: cache }));

    await callWidget(client, { ...RENEWABLE_META, [EXPIRES_AT_KEY]: Date.now() - 1_000 });

    expect(calls).toEqual([{ refreshToken: "r1", force: false }]);
    expect(seen).toEqual(["fresh-1"]);
  });

  it("renews before the call when expiry is inside the clock skew but not yet past", async () => {
    // A token with four seconds left cannot survive the round trip, and the
    // clock here is not the clock at Hermes.
    const { cache, calls } = fakeCache();
    const { seen, createClient } = tokensSeen();
    const client = await buildServerAndClient(baseCtx({ createClient, tokens: cache }));

    await callWidget(client, { ...RENEWABLE_META, [EXPIRES_AT_KEY]: Date.now() + 4_000 });

    expect(calls).toHaveLength(1);
    expect(seen).toEqual(["fresh-1"]);
  });

  it("sends the token the caller gave, untouched, while it is still good", async () => {
    const { cache, calls } = fakeCache();
    const { seen, createClient } = tokensSeen();
    const client = await buildServerAndClient(baseCtx({ createClient, tokens: cache }));

    await callWidget(client, { ...RENEWABLE_META, [EXPIRES_AT_KEY]: Date.now() + 3_600_000 });

    expect(calls).toHaveLength(0);
    expect(seen).toEqual(["t"]);
  });

  it("renews and retries once when Hermes rejects the token mid-flight", async () => {
    // The expiry says the token is fine; Hermes disagrees. Hermes wins.
    const { cache, calls } = fakeCache();
    const seen: string[] = [];
    const client = await buildServerAndClient(
      baseCtx({
        tokens: cache,
        createClient: (user) => {
          seen.push(user.accessToken);
          return {
            request: async () => {
              if (user.accessToken === "t") throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
              return { id: "w1" };
            },
          };
        },
      })
    );

    const result = await callWidget(client, { ...RENEWABLE_META, [EXPIRES_AT_KEY]: Date.now() + 3_600_000 });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(JSON.stringify({ id: "w1" }));
    // Forced, because the cached copy is exactly what Hermes just refused.
    expect(calls).toEqual([{ refreshToken: "r1", force: true }]);
    expect(seen).toEqual(["t", "fresh-1"]);
  });

  it("gives up after one renewal rather than looping on a token Hermes keeps refusing", async () => {
    const { cache, calls } = fakeCache();
    const request = vi.fn(async () => {
      throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
    });
    const client = await buildServerAndClient(
      baseCtx({ tokens: cache, createClient: () => ({ request }) })
    );

    const result = await callWidget(client, RENEWABLE_META);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNAUTHENTICATED");
    expect(request).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
  });

  it("does not retry when renewal hands back the very token that was refused", async () => {
    // Retrying with an identical token asks Hermes the same question twice.
    const { cache } = fakeCache(() => ({
      accessToken: "t",
      refreshToken: "r1",
      expiresAt: Date.now() + 3_600_000,
    }));
    const request = vi.fn(async () => {
      throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
    });
    const client = await buildServerAndClient(
      baseCtx({ tokens: cache, createClient: () => ({ request }) })
    );

    const result = await callWidget(client, RENEWABLE_META);

    expect(result.isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports a dead refresh token as SESSION_EXPIRED, not as a plain rejection", async () => {
    // This one the caller can act on: the merchant has to sign in again.
    const cache = {
      accessTokenFor: async () => {
        throw new SessionExpiredError("the refresh token has expired");
      },
    } as unknown as TokenCache;
    const client = await buildServerAndClient(
      baseCtx({
        tokens: cache,
        createClient: () => ({
          request: async () => {
            throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
          },
        }),
      })
    );

    const result = await callWidget(client, RENEWABLE_META);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("SESSION_EXPIRED");
    expect(textOf(result)).toContain("sign in again");
  });

  it("leaves a 403 alone — renewal cannot grant a permission the user lacks", async () => {
    const { cache, calls } = fakeCache();
    const client = await buildServerAndClient(
      baseCtx({
        tokens: cache,
        createClient: () => ({
          request: async () => {
            throw new HermesForbiddenError("/api/v1/widgets/w1");
          },
        }),
      })
    );

    const result = await callWidget(client, RENEWABLE_META);

    expect(textOf(result)).toContain("FORBIDDEN");
    expect(calls).toHaveLength(0);
  });

  it("never renews a session the call granted no refresh token for", async () => {
    const { cache, calls } = fakeCache();
    const request = vi.fn(async () => {
      throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
    });
    const client = await buildServerAndClient(
      baseCtx({ tokens: cache, createClient: () => ({ request }) })
    );

    // An expiry long past, but no refresh token: nothing to renew with.
    await callWidget(client, { ...CREDENTIAL_META, [EXPIRES_AT_KEY]: 1 });

    expect(calls).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the renewed call acting on the same store as the original", async () => {
    // Renewal replaces a credential, never a scope. A refresh response naming
    // other stores must not widen what this call can touch.
    const { cache } = fakeCache();
    const stores: string[] = [];
    const client = await buildServerAndClient(
      baseCtx({
        tokens: cache,
        createClient: (user) => {
          stores.push(user.storeId);
          return { request: async () => ({ ok: true }) };
        },
      })
    );

    await callWidget(client, { ...RENEWABLE_META, [EXPIRES_AT_KEY]: 1 });

    expect(stores).toEqual(["s1"]);
  });

  it("logs the renewal without ever writing a token into the log", async () => {
    const lines: string[] = [];
    const { cache } = fakeCache();
    const { createClient } = tokensSeen();
    const client = await buildServerAndClient(
      baseCtx({
        tokens: cache,
        createClient,
        logger: createLogger({ logLevel: "debug" }, (line) => lines.push(line)),
      })
    );

    await callWidget(client, { ...RENEWABLE_META, [EXPIRES_AT_KEY]: 1 });

    const joined = lines.join("\n");
    expect(joined).toContain("renewed hermes session");
    expect(joined).not.toContain("r1");
    expect(joined).not.toContain("fresh-1");
  });
});
