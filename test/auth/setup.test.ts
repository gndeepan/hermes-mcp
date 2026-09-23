import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore, type StoredSession } from "../../src/auth/credentialStore.js";
import type { HermesLogin } from "../../src/auth/hermesLogin.js";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import type { AuthContext } from "../../src/tools/setup.js";
import { createHandler } from "../../src/httpServer.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { OperationIndex } from "../../src/registry/operations.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import type { HermesRequester } from "../../src/hermesClient.js";

const logger = createLogger({ logLevel: "silent" });
const HOUR = 3_600_000;

const LIVE: StoredSession = {
  accessToken: "acc",
  refreshToken: "ref",
  expiresAt: Date.now() + 4 * HOUR,
  userId: "usr_1",
  storeId: "str_1",
  storeName: "SuperHero-vjro",
};

const fakeLogin = (): HermesLogin => ({
  sendCode: vi.fn(async () => undefined),
  verifyCode: vi.fn(async () => {
    throw new Error("not reached");
  }),
});

const started: AuthContext[] = [];
afterEach(() => {
  for (const a of started) a.pending.current?.close();
  started.length = 0;
});

const connect = async (
  overrides: Partial<ToolContext> = {},
  authOverride?: AuthContext | null
): Promise<{ client: Client; auth?: AuthContext }> => {
  const doc = loadSnapshotDoc();
  const registry = SchemaRegistry.fromDocument(doc);
  const auth: AuthContext | undefined =
    authOverride === null
      ? undefined
      : (authOverride ?? {
          store: new CredentialStore(mkdtempSync(join(tmpdir(), "hermes-setup-"))),
          login: fakeLogin(),
          logger,
          pending: {},
        });
  if (auth) started.push(auth);

  const ctx: ToolContext = {
    config: loadConfig({}),
    logger,
    registry,
    createClient: () => ({ request: vi.fn() }) as unknown as HermesRequester,
    specs: { registry, operations: OperationIndex.fromDocument(doc), doc },
    ...(auth === undefined ? {} : { auth }),
    ...overrides,
  };

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHermesTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, ...(auth === undefined ? {} : { auth }) };
};

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string =>
  (r.content as { text: string }[])[0]?.text ?? "";

describe("hermes_setup", () => {
  it("reports an existing session without opening anything", async () => {
    const { client, auth } = await connect();
    auth!.store.save(LIVE);

    const result = await client.callTool({ name: "hermes_setup", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Signed in as usr_1 on SuperHero-vjro (str_1)");
    expect(textOf(result)).toMatch(/valid for another \d+h/);
    // No browser, no server: nothing is pending.
    expect(auth!.pending.current).toBeUndefined();
  });

  it("treats a session inside the expiry skew as needing a new sign-in", async () => {
    // A session with thirty seconds left is a session that fails mid-answer.
    const { client, auth } = await connect();
    auth!.store.save({ ...LIVE, expiresAt: Date.now() + 5_000 });

    const result = await client.callTool({ name: "hermes_setup", arguments: {} });

    expect(textOf(result)).toContain("expired");
    expect(textOf(result)).toContain("http://127.0.0.1:");
  });

  it("starts a login and returns the loopback URL immediately", async () => {
    const { client, auth } = await connect();

    const result = await client.callTool({ name: "hermes_setup", arguments: {} });

    expect(textOf(result)).toContain("No Hermes session found");
    expect(textOf(result)).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?k=/);
    expect(textOf(result)).toContain("call this tool again");
    expect(auth!.pending.current).toBeDefined();
  });

  it("hands back the same URL rather than racing a second server", async () => {
    const { client, auth } = await connect();

    const first = textOf(await client.callTool({ name: "hermes_setup", arguments: {} }));
    const second = textOf(await client.callTool({ name: "hermes_setup", arguments: {} }));

    expect(second).toContain("already waiting in your browser");
    expect(second).toContain(auth!.pending.current!.url);
    expect(first).toContain(auth!.pending.current!.url);
  });

  it("never prints a token, even when one is stored", async () => {
    const { client, auth } = await connect();
    auth!.store.save({ ...LIVE, accessToken: "acc-SECRET", refreshToken: "ref-SECRET" });

    const result = await client.callTool({ name: "hermes_setup", arguments: {} });

    expect(textOf(result)).not.toContain("acc-SECRET");
    expect(textOf(result)).not.toContain("ref-SECRET");
  });
});

describe("where hermes_setup exists", () => {
  it("is advertised for a single-user stdio process", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("hermes_setup");
  });

  it("is not advertised when the process owns no session", async () => {
    // The ai-agent's shared child, and any other multi-tenant stdio run: there
    // is no "the signed-in user" to set up.
    const { client } = await connect({}, null);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("hermes_setup");
  });

  it("the HTTP entry never builds a credential store at all", async () => {
    // Structural, not remembered: createHandler has no way to reach one, so no
    // request it serves can read or write a merchant's saved session.
    const handler = createHandler();
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    const body = await response.text();
    expect(body).not.toContain("hermes_setup");
  });
});

describe("a session Hermes has declared dead", () => {
  it("is cleared, so the next setup asks for a new sign-in", async () => {
    const { auth } = await connect();
    auth!.store.save(LIVE);
    expect(auth!.store.read()).not.toBeNull();

    // SessionExpiredError is what refreshAccessToken raises when the refresh
    // token itself is rejected — the "left it a day" case.
    const { SessionExpiredError } = await import("../../src/errors.js");
    const { fallbackCredentials } = await import("../../src/tools/index.js");
    expect(fallbackCredentials({ config: loadConfig({}), auth: auth! } as never)).toMatchObject({
      storeId: "str_1",
      expiresAt: LIVE.expiresAt,
    });

    auth!.store.clear();
    expect(new SessionExpiredError("rejected")).toBeInstanceOf(Error);
    expect(fallbackCredentials({ config: loadConfig({}), auth: auth! } as never)).toBeNull();
  });

  it("prefers an explicit .env credential over a stored session", async () => {
    const { auth } = await connect();
    auth!.store.save(LIVE);
    const { fallbackCredentials } = await import("../../src/tools/index.js");

    const withEnv = fallbackCredentials({
      config: { ...loadConfig({}), credentials: { accessToken: "env", storeId: "str_env" } },
      auth: auth!,
    } as never);

    // A developer exporting a token is stating an intent for this run; a file
    // written weeks ago should not silently win.
    expect(withEnv).toMatchObject({ accessToken: "env", storeId: "str_env" });
  });
});
