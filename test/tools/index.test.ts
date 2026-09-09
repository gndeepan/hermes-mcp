import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { ENDPOINTS } from "../../src/registry/endpoints.js";
import { createLogger } from "../../src/logging.js";
import { loadConfig } from "../../src/config.js";
import { TokenManager } from "../../src/auth/tokenManager.js";
import type { StoredCredentials, TokenStore } from "../../src/auth/tokenStore.js";
import type { HermesRequester } from "../../src/hermesClient.js";
import type { OpenApiDocument } from "../../src/registry/schemaFromOpenApi.js";
import { HermesNotFoundError, HermesUnauthenticatedError } from "../../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const noopStore: TokenStore = { read: () => null, write: () => {} };

const validCredentials: StoredCredentials = {
  accessToken: "t",
  refreshToken: "r",
  expiresAt: Date.now() + 3_600_000,
  storeId: "s1",
};

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
  tokenManager: new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, validCredentials),
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

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/widgets/w1", { query: {}, body: undefined });
    expect(JSON.parse(textOf(result))).toEqual({ id: "w1", display: true });
  });

  it("returns MISSING_CREDENTIALS and never calls Hermes when no credentials are loaded", async () => {
    const request = vi.fn();
    const client = await buildServerAndClient(
      baseCtx({
        tokenManager: new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, null),
        createClient: () => ({ request }),
      })
    );

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(request).not.toHaveBeenCalled();
  });

  it("separates path params from query params for hermes_list_custom_blocks", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    await client.callTool({
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

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "missing" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
  });

  it("refreshes the token once and retries on a 401, succeeding on the retry", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
      return { id: "w1" };
    });
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: Date.now() + 3_600_000,
    }));
    const tokenManager = new TokenManager(
      { store: noopStore, baseUrl: "https://hermes.test", refresh },
      validCredentials
    );
    const client = await buildServerAndClient(baseCtx({ tokenManager, createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("gives up after exactly one retry and surfaces UNAUTHENTICATED", async () => {
    const request = vi.fn(async () => {
      throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
    });
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: Date.now() + 3_600_000,
    }));
    const tokenManager = new TokenManager(
      { store: noopStore, baseUrl: "https://hermes.test", refresh },
      validCredentials
    );
    const client = await buildServerAndClient(baseCtx({ tokenManager, createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNAUTHENTICATED");
    expect(request).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("logs a debug line and an info line sharing one traceId per call", async () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));
    const request = vi.fn(async () => ({ id: "w1" }));
    const client = await buildServerAndClient(baseCtx({ logger, createClient: () => ({ request }) }));

    await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

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
