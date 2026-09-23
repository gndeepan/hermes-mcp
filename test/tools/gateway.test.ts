import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { OperationIndex } from "../../src/registry/operations.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { ACCESS_TOKEN_KEY, STORE_ID_KEY } from "../../src/userContext.js";
import type { HermesRequester } from "../../src/hermesClient.js";

const CREDENTIAL_META = { [ACCESS_TOKEN_KEY]: "tok", [STORE_ID_KEY]: "str_mine" };

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

const connect = async (request: ReturnType<typeof vi.fn>): Promise<Client> => {
  const doc = loadSnapshotDoc();
  const registry = SchemaRegistry.fromDocument(doc);
  const ctx: ToolContext = {
    config: loadConfig({}),
    logger: createLogger({ logLevel: "silent" }),
    registry,
    createClient: () => ({ request }) as unknown as HermesRequester,
    specs: { registry, operations: OperationIndex.fromDocument(doc), doc },
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHermesTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe("hermes_find_api", () => {
  it("returns candidates without calling Hermes", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_find_api",
      arguments: { query: "get user info" },
    });

    expect(result.isError).toBeFalsy();
    expect(request).not.toHaveBeenCalled();
    const payload = JSON.parse(textOf(result)) as { candidates: { path: string; method: string }[] };
    expect(payload.candidates[0]).toMatchObject({ method: "get", path: "/api/v1/users/{id}" });
  });

  it("describes operations no curated tool covers", async () => {
    const client = await connect(vi.fn());
    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_find_api",
      arguments: { query: "campaigns", limit: 5 },
    });
    const payload = JSON.parse(textOf(result)) as { candidates: unknown[] };
    expect(payload.candidates.length).toBeGreaterThan(0);
  });

  it("needs no credentials, because it reaches nothing", async () => {
    const client = await connect(vi.fn());
    const result = await client.callTool({ name: "hermes_find_api", arguments: { query: "theme" } });
    expect(result.isError).toBeFalsy();
  });
});

describe("hermes_call_api", () => {
  it("invokes the operation through HermesClient", async () => {
    const request = vi.fn(async () => ({ id: "thm_1" }));
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active" },
    });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/themes/active", { query: {}, body: undefined });
    expect(JSON.parse(textOf(result))).toEqual({ id: "thm_1" });
  });

  it("substitutes and encodes path parameters", async () => {
    const request = vi.fn(async () => ({}));
    const client = await connect(request);

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/stores/{id}/info", pathParams: { id: "str_mine" } },
    });

    expect(request).toHaveBeenCalledWith("get", "/api/v1/stores/str_mine/info", {
      query: {},
      body: undefined,
    });
  });

  it("refuses an operation the document does not have, and sends nothing", async () => {
    // Review Focus #1: this must read as UNKNOWN_OPERATION, not as an opaque
    // "The tool failed unexpectedly. Reference <hex>".
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "post", path: "/api/v1/users/{id}", pathParams: { id: "usr_1" } },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[UNKNOWN_OPERATION]");
    // Naming the verbs that do exist turns a dead end into a correction.
    expect(textOf(result)).toContain("GET /api/v1/users/{id}");
  });

  it("refuses a missing path parameter and sends nothing", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/stores/{id}/info", pathParams: {} },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[INVALID_PATH_PARAM]");
  });

  it("refuses another merchant's store id in pathParams", async () => {
    // Review Focus #2: the flat guard read only args.storeId and would have
    // sent this.
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "put",
        path: "/api/v1/stores/{storeId}/users/{userId}",
        pathParams: { storeId: "str_SOMEONE_ELSE", userId: "usr_1" },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("refuses another merchant's store id in the body", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "put",
        path: "/api/v1/users/{id}",
        pathParams: { id: "usr_1" },
        body: { storeId: "str_SOMEONE_ELSE" },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("returns MISSING_CREDENTIALS and reaches nothing without credentials", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active" },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[MISSING_CREDENTIALS]");
  });

  it("returns valid output when Hermes answers with no body", async () => {
    // JSON.stringify(undefined) is undefined, not a string, which left `text`
    // missing and made the whole tools/call result invalid against the MCP
    // schema — surfacing to the caller as a protocol error rather than as the
    // successful empty response it was.
    const request = vi.fn(async () => undefined);
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("null");
  });

  it("coerces non-string query values", async () => {
    const request = vi.fn(async () => ({}));
    const client = await connect(request);

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active", query: { page: 1, tags: ["a", "b"] } },
    });

    expect(request).toHaveBeenCalledWith("get", "/api/v1/themes/active", {
      query: { page: "1", tags: "a,b" },
      body: undefined,
    });
  });
});

describe("gateway tool descriptions", () => {
  it("warns that hermes_call_api can destroy data, and prefers the curated tools", async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();

    const find = tools.find((t) => t.name === "hermes_find_api");
    const call = tools.find((t) => t.name === "hermes_call_api");
    expect(find).toBeDefined();
    expect(call).toBeDefined();
    expect(find!.description!.length).toBeGreaterThanOrEqual(120);
    expect(call!.description!.length).toBeGreaterThanOrEqual(120);
    expect(call!.description).toMatch(/MODIFY AND DELETE/);
    expect(find!.description).toMatch(/never calls anything/i);
  });

  it("lists the curated tools before the gateway", async () => {
    const client = await connect(vi.fn());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.indexOf("hermes_get_active_theme")).toBeLessThan(names.indexOf("hermes_call_api"));
  });
});
