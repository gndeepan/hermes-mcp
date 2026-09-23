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

const connect = async (
  request: ReturnType<typeof vi.fn>,
  options: { warn?: ReturnType<typeof vi.fn>; ctx?: Partial<ToolContext> } = {}
): Promise<Client> => {
  const doc = loadSnapshotDoc();
  const registry = SchemaRegistry.fromDocument(doc);
  const logger = createLogger({ logLevel: "silent" });
  if (options.warn) logger.warn = options.warn as unknown as typeof logger.warn;
  const ctx: ToolContext = {
    config: loadConfig({}),
    logger,
    registry,
    createClient: () => ({ request }) as unknown as HermesRequester,
    specs: { registry, operations: OperationIndex.fromDocument(doc), doc },
    ...options.ctx,
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

describe("hermes_call_api cross-tenant guard", () => {
  // Hermes spells the store id `{id}` on 18 paths and `{storeId}` on 31, and
  // takes it as a query parameter on 4 more. A guard that looks for the literal
  // key "storeId" at depth 1 sees fewer than half of them.

  it("refuses a foreign store named by an {id} placeholder under /stores", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "get",
        path: "/api/v1/stores/{id}/info",
        pathParams: { id: "str_SOMEONE_ELSE" },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("refuses a foreign store on a destructive operation", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "delete",
        path: "/api/v1/stores/{id}",
        pathParams: { id: "str_SOMEONE_ELSE" },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("refuses a foreign store id passed as a query parameter", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "get",
        path: "/api/v1/themes/active",
        query: { storeId: "str_SOMEONE_ELSE" },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("refuses a foreign store id nested inside the body", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "put",
        path: "/api/v1/users/{id}",
        pathParams: { id: "usr_1" },
        body: { store: { storeId: "str_SOMEONE_ELSE" } },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("refuses a foreign store id inside an array body", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "put",
        path: "/api/v1/store-switchers",
        body: [{ storeId: "str_SOMEONE_ELSE" }],
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("fails closed on a storeId that is not a scalar", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "put",
        path: "/api/v1/users/{id}",
        pathParams: { id: "usr_1" },
        body: { storeId: ["str_SOMEONE_ELSE"] },
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[STORE_MISMATCH]");
  });

  it("still allows the caller's own store under any spelling", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/stores/{id}/info", pathParams: { id: "str_mine" } },
    });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/stores/str_mine/info", {
      query: {},
      body: undefined,
    });
  });
});

describe("hermes_call_api path escape", () => {
  // encodeURIComponent("..") is "..", and new URL(path, base) then applies
  // RFC-3986 dot-segment removal — so /api/v1/stores/../info is requested as
  // /api/v1/info, an operation the document does not contain. The curated path
  // has guarded this since before the gateway existed.

  it("refuses a dot-only path parameter", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      // A non-store path, so the dot-segment guard is what is under test here
      // rather than the store guard, which also refuses ".." on a store path.
      arguments: { method: "get", path: "/api/v1/users/{id}", pathParams: { id: ".." } },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[INVALID_PATH_PARAM]");
  });

  it("refuses a single-dot path parameter", async () => {
    const request = vi.fn();
    const client = await connect(request);

    const result = await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/users/{id}", pathParams: { id: "." } },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[INVALID_PATH_PARAM]");
  });

  it("still allows a dot inside a real identifier", async () => {
    const request = vi.fn(async () => ({}));
    const client = await connect(request);

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/users/{id}", pathParams: { id: "a.b.c" } },
    });

    expect(request).toHaveBeenCalledWith("get", "/api/v1/users/a.b.c", {
      query: {},
      body: undefined,
    });
  });
});

describe("hermes_call_api audit trail", () => {
  it("logs every non-GET call at warn, naming the method and the operation", async () => {
    // The entire stated mitigation for any-method access. Nothing pinned it, so
    // deleting the log line kept the suite green.
    const warn = vi.fn();
    const client = await connect(vi.fn(async () => ({})), { warn });

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "put", path: "/api/v1/users/{id}", pathParams: { id: "usr_1" } },
    });

    const line = warn.mock.calls.find((c) => c[0] === "gateway write call");
    expect(line).toBeDefined();
    expect(line![1]).toMatchObject({ method: "put", operation: "/api/v1/users/{id}" });
  });

  it("does not log a GET as a write", async () => {
    const warn = vi.fn();
    const client = await connect(vi.fn(async () => ({})), { warn });

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active" },
    });

    expect(warn.mock.calls.find((c) => c[0] === "gateway write call")).toBeUndefined();
  });

  it("never puts a substituted path value in the audit line", async () => {
    // DELETE /api/v1/customers/{token} is a real operation, and logging.ts
    // redacts by key name — so a resolved path would carry the secret verbatim
    // under the innocuous key "path", against hard constraint #4.
    const warn = vi.fn();
    const client = await connect(vi.fn(async () => ({})), { warn });

    await client.callTool({
      _meta: CREDENTIAL_META,
      name: "hermes_call_api",
      arguments: {
        method: "put",
        path: "/api/v1/users/{id}",
        pathParams: { id: "SUPERSECRETVALUE" },
      },
    });

    const line = warn.mock.calls.find((c) => c[0] === "gateway write call");
    expect(JSON.stringify(line)).not.toContain("SUPERSECRETVALUE");
  });
});

describe("hermes_call_api credential sources", () => {
  it("uses HTTP credentials when the request carried them", async () => {
    const request = vi.fn(async () => ({}));
    const client = await connect(request, {
      ctx: {
        httpCredentials: { accessToken: "http-tok", storeId: "str_http" },
        allowEnvFallback: false,
      },
    });

    const result = await client.callTool({
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/stores/{id}/info", pathParams: { id: "str_http" } },
    });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalled();
  });

  it("refuses to fall back to the environment when the entry forbids it", async () => {
    const request = vi.fn();
    const client = await connect(request, {
      ctx: {
        allowEnvFallback: false,
        config: { ...loadConfig({}), credentials: { accessToken: "env", storeId: "str_env" } },
      },
    });

    const result = await client.callTool({
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active" },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("[MISSING_CREDENTIALS]");
  });
});
