import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore, type StoredSession } from "../../src/auth/credentialStore.js";
import type { HermesLogin, LoginSession } from "../../src/auth/hermesLogin.js";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import type { AuthContext } from "../../src/tools/setup.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { OperationIndex } from "../../src/registry/operations.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { HermesUnauthenticatedError, SessionExpiredError } from "../../src/errors.js";
import type { SessionTokens, TokenCache } from "../../src/tokenRefresh.js";

const logger = createLogger({ logLevel: "silent" });
const HOUR = 3_600_000;

const SIGNED_IN: LoginSession = {
  accessToken: "browser-acc",
  refreshToken: "browser-ref",
  expiresAt: Date.now() + 4 * HOUR,
  userId: "usr_1",
  stores: [{ id: "str_1", name: "Shop" }],
  isAdmin: false,
};

const STORED: StoredSession = {
  accessToken: "stored-acc",
  refreshToken: "stored-ref",
  expiresAt: Date.now() + 4 * HOUR,
  userId: "usr_1",
  storeId: "str_1",
  storeName: "Shop",
};

const fakeLogin = (): HermesLogin => ({
  sendCode: vi.fn(async () => undefined),
  verifyCode: vi.fn(async () => SIGNED_IN),
});

/** What the merchant does in the browser tab: email, then code. One store picks itself. */
const signInThroughBrowser = async (url: string): Promise<void> => {
  const u = new URL(url);
  const k = u.searchParams.get("k")!;
  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${u.origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ k, ...fields }),
      redirect: "manual",
    });
  await post("/email", { email: "a@b.com" });
  await post("/otp", { code: "123456" });
};

const started: AuthContext[] = [];
afterEach(() => {
  for (const a of started) a.pending.current?.close();
  started.length = 0;
});

interface Harness {
  client: Client;
  auth: AuthContext;
  seen: string[];
  opened: string[];
}

const connect = async (options: {
  /** What the "browser" does once opened. Defaults to signing in. */
  browser?: (url: string) => Promise<void> | void;
  request?: (accessToken: string) => Promise<unknown>;
  tokens?: TokenCache;
  loginWaitMs?: number;
  env?: ToolContext["config"]["credentials"];
}): Promise<Harness> => {
  const doc = loadSnapshotDoc();
  const registry = SchemaRegistry.fromDocument(doc);
  const opened: string[] = [];
  const browser = options.browser ?? signInThroughBrowser;
  const auth: AuthContext = {
    store: new CredentialStore(mkdtempSync(join(tmpdir(), "hermes-auto-"))),
    login: fakeLogin(),
    logger,
    pending: {},
    openBrowser: async (url) => {
      opened.push(url);
      void browser(url);
      return true;
    },
  };
  started.push(auth);

  const seen: string[] = [];
  const ctx: ToolContext = {
    config: {
      ...loadConfig({ HERMES_SINGLE_USER: "1" }),
      credentials: options.env ?? null,
      loginWaitMs: options.loginWaitMs ?? 10_000,
    },
    logger,
    registry,
    createClient: (user) => {
      seen.push(user.accessToken);
      return { request: async () => (options.request ?? (async () => ({ id: "w1" })))(user.accessToken) };
    },
    specs: { registry, operations: OperationIndex.fromDocument(doc), doc },
    auth,
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  };

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHermesTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, auth, seen, opened };
};

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string =>
  (r.content as { text: string }[])[0]?.text ?? "";

const getWidget = (client: Client) => client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

const cacheThat = (answer: (refreshToken: string) => Promise<SessionTokens>) => {
  const asked: string[] = [];
  const cache = {
    accessTokenFor: async (refreshToken: string) => {
      asked.push(refreshToken);
      return answer(refreshToken);
    },
  } as unknown as TokenCache;
  return { cache, asked };
};

describe("the first question with nobody signed in", () => {
  it("opens the browser, waits for sign-in, then answers the same call", async () => {
    const { client, auth, seen, opened } = await connect({});

    const result = await getWidget(client);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(JSON.stringify({ id: "w1" }));
    expect(opened).toHaveLength(1);
    // The request went out with the session the browser produced, and it was saved.
    expect(seen).toEqual(["browser-acc"]);
    expect(auth.store.read()).toMatchObject({ accessToken: "browser-acc", storeId: "str_1" });
  });

  it("answers SIGN_IN_REQUIRED with the URL when the user is still signing in", async () => {
    const { client, seen } = await connect({ browser: () => undefined, loginWaitMs: 50 });

    const result = await getWidget(client);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^\[SIGN_IN_REQUIRED\].*http:\/\/127\.0\.0\.1:\d+\/\?k=/);
    expect(seen).toEqual([]);
  });

  it("joins the open sign-in on the next call rather than opening a second one", async () => {
    let finish: (() => Promise<void>) | undefined;
    const { client, opened } = await connect({
      browser: (url) => {
        finish = () => signInThroughBrowser(url);
      },
      loginWaitMs: 50,
    });

    expect(textOf(await getWidget(client))).toContain("SIGN_IN_REQUIRED");
    // The user finishes in the tab they already have, and the model calls again.
    await finish!();
    await new Promise((r) => setTimeout(r, 400));
    const retried = await getWidget(client);

    expect(retried.isError).toBeFalsy();
    expect(opened).toHaveLength(1);
  });

  it("never opens a browser for a call that brought its own credentials", async () => {
    const { client, opened } = await connect({});

    const result = await client.callTool({
      _meta: { "com.superfans.hermes/accessToken": "" , "com.superfans.hermes/storeId": "str_1" },
      name: "hermes_get_widget",
      arguments: { id: "w1" },
    });

    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(opened).toEqual([]);
  });

  it("does the same for hermes_call_api, which now reads the signed-in session too", async () => {
    const { client, seen, opened } = await connect({});

    const result = await client.callTool({
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/widgets/{id}", pathParams: { id: "w1" } },
    });

    expect(result.isError).toBeFalsy();
    expect(opened).toHaveLength(1);
    expect(seen).toEqual(["browser-acc"]);
  });

  it("hermes_call_api uses an existing stored session without opening anything", async () => {
    const { client, auth, seen, opened } = await connect({});
    auth.store.save(STORED);

    await client.callTool({
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/widgets/{id}", pathParams: { id: "w1" } },
    });

    expect(opened).toEqual([]);
    expect(seen).toEqual(["stored-acc"]);
  });
});

describe("a 401 in the middle of a session", () => {
  it("renews, retries, and saves the rotated tokens so a restart stays signed in", async () => {
    const { cache, asked } = cacheThat(async () => ({
      accessToken: "renewed-acc",
      refreshToken: "rotated-ref",
      expiresAt: Date.now() + HOUR,
    }));
    const { client, auth, seen, opened } = await connect({
      tokens: cache,
      request: async (token) => {
        if (token === "stored-acc") throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
        return { id: "w1" };
      },
    });
    auth.store.save(STORED);

    const result = await getWidget(client);

    expect(result.isError).toBeFalsy();
    expect(asked).toEqual(["stored-ref"]);
    expect(seen).toEqual(["stored-acc", "renewed-acc"]);
    expect(opened).toEqual([]);
    expect(auth.store.read()).toMatchObject({ accessToken: "renewed-acc", refreshToken: "rotated-ref" });
  });

  it("signs in through the browser when the refresh token is dead too, then finishes the call", async () => {
    const { cache } = cacheThat(async () => {
      throw new SessionExpiredError("rejected");
    });
    const { client, auth, seen, opened } = await connect({
      tokens: cache,
      request: async (token) => {
        if (token === "stored-acc") throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
        return { id: "w1" };
      },
    });
    auth.store.save(STORED);

    const result = await getWidget(client);

    expect(result.isError).toBeFalsy();
    expect(opened).toHaveLength(1);
    expect(seen).toEqual(["stored-acc", "browser-acc"]);
    expect(auth.store.read()).toMatchObject({ accessToken: "browser-acc" });
  });

  it("retires a dead .env session so the browser sign-in can replace it", async () => {
    const { client, auth, seen, opened } = await connect({
      // A pasted token with no refresh token: a 401 means it is simply over.
      env: { accessToken: "env-acc", storeId: "str_1" },
      request: async (token) => {
        if (token === "env-acc") throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
        return { id: "w1" };
      },
    });

    const first = await getWidget(client);
    const second = await getWidget(client);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(auth.envRetired).toBe(true);
    expect(opened).toHaveLength(1);
    expect(seen).toEqual(["env-acc", "browser-acc", "browser-acc"]);
  });
});

describe("hermes_setup with a lapsed access token", () => {
  it("renews silently instead of sending the user to the browser", async () => {
    const { cache } = cacheThat(async () => ({
      accessToken: "renewed-acc",
      refreshToken: "rotated-ref",
      expiresAt: Date.now() + HOUR,
    }));
    const { client, auth, opened } = await connect({ tokens: cache });
    auth.store.save({ ...STORED, expiresAt: Date.now() - 1_000 });

    const result = await client.callTool({ name: "hermes_setup", arguments: {} });

    expect(textOf(result)).toContain("Signed in as usr_1 on Shop");
    expect(opened).toEqual([]);
    expect(auth.store.read()).toMatchObject({ accessToken: "renewed-acc", refreshToken: "rotated-ref" });
  });
});
