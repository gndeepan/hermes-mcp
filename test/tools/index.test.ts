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
import { HermesNotFoundError, HermesUnauthenticatedError } from "../../src/errors.js";
import { ACCESS_TOKEN_KEY, REQUEST_ID_KEY, STORE_ID_KEY } from "../../src/userContext.js";
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

  it("surfaces a 401 to the caller without retrying — this server cannot mint a token", async () => {
    // The caller owns the credential's lifetime, exactly as in the AI Server:
    // a rejected session is their answer to act on, not something to paper over.
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
    const request = vi.fn(async () => ({ items: [] }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_list_custom_blocks",
      arguments: { storeId: "{storeId}", page: 1 },
    });

    const [, calledPath] = request.mock.calls[0] as unknown as [string, string];
    expect(calledPath).toBe("/api/v1/stores/%7BstoreId%7D/custom-blocks");
    expect(calledPath).not.toMatch(/\{[^}]+\}/);
    expect(calledPath.endsWith("/custom-blocks")).toBe(true);
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

