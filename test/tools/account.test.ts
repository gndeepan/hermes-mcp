import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore, type StoredSession } from "../../src/auth/credentialStore.js";
import type { HermesLogin } from "../../src/auth/hermesLogin.js";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import type { AuthContext } from "../../src/tools/setup.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { OperationIndex } from "../../src/registry/operations.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { clearEnvCredentials } from "../../src/envFile.js";
import { HermesForbiddenError, HermesUnavailableError } from "../../src/errors.js";
import { TokenCache } from "../../src/tokenRefresh.js";

const logger = createLogger({ logLevel: "silent" });
const HOUR = 3_600_000;

const STORED: StoredSession = {
  accessToken: "stored-acc",
  refreshToken: "stored-ref",
  expiresAt: Date.now() + 4 * HOUR,
  userId: "usr_1",
  storeId: "str_1",
  storeName: "Shop",
};

const ME = {
  id: "usr_1",
  name: "Deepan",
  email: "a@b.com",
  status: "ACTIVE",
  isAdmin: false,
  lastLoggedInAt: 1_900_000_000_000,
  permissions: "all",
  roleId: "role_1",
};

const STORES = [
  { id: "str_1", name: "Shop", domain: "shop.myshopify.com", sfAccessToken: "sf-SECRET" },
  { id: "str_2", name: "Other", domain: "other.myshopify.com", sfAccessToken: "sf-SECRET-2" },
];

const started: AuthContext[] = [];
afterEach(() => {
  for (const a of started) a.pending.current?.close();
  started.length = 0;
});

const connect = async (
  options: {
    auth?: boolean;
    env?: ToolContext["config"]["credentials"];
    envFile?: string;
    stores?: () => Promise<unknown>;
    me?: () => Promise<unknown>;
    tokens?: TokenCache;
  } = {}
) => {
  const doc = loadSnapshotDoc();
  const registry = SchemaRegistry.fromDocument(doc);
  const opened: string[] = [];
  const auth: AuthContext | undefined =
    options.auth === false
      ? undefined
      : {
          store: new CredentialStore(mkdtempSync(join(tmpdir(), "hermes-account-"))),
          login: { sendCode: vi.fn(), verifyCode: vi.fn() } as unknown as HermesLogin,
          logger,
          pending: {},
          envFile: options.envFile ?? null,
          openBrowser: async (url) => {
            opened.push(url);
            return true;
          },
        };
  if (auth) started.push(auth);

  const requests: { token: string; path: string }[] = [];
  const ctx: ToolContext = {
    config: { ...loadConfig({ HERMES_SINGLE_USER: "1" }), credentials: options.env ?? null },
    logger,
    registry,
    createClient: (user) => ({
      request: async (_method: string, path: string) => {
        requests.push({ token: user.accessToken, path });
        if (path === "/api/v1/users/me") return (options.me ?? (async () => ME))();
        if (path === "/api/v1/users/usr_1") return ME;
        if (path === "/api/v1/users/me/stores") return (options.stores ?? (async () => STORES))();
        return { ok: true };
      },
    }),
    specs: { registry, operations: OperationIndex.fromDocument(doc), doc },
    ...(auth === undefined ? {} : { auth }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
  };

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHermesTools(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, auth, requests, opened };
};

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string =>
  (r.content as { text: string }[])[0]?.text ?? "";

const whoami = (client: Client, meta?: Record<string, unknown>) =>
  client.callTool({ name: "hermes_whoami", arguments: {}, ...(meta ? { _meta: meta } : {}) });

describe("hermes_whoami", () => {
  it("shows the signed-in user, the store, and every accessible store", async () => {
    const { client, auth } = await connect();
    auth!.store.save(STORED);

    const result = await whoami(client);
    const body = JSON.parse(textOf(result));

    expect(result.isError).toBeFalsy();
    expect(body.signedIn).toBe(true);
    expect(body.user).toMatchObject({ id: "usr_1", name: "Deepan", email: "a@b.com", status: "ACTIVE" });
    expect(body.user.lastLoggedInAt).toBe(new Date(1_900_000_000_000).toISOString());
    expect(body.store).toEqual({ id: "str_1", name: "Shop" });
    expect(body.stores).toEqual([
      { id: "str_1", name: "Shop", domain: "shop.myshopify.com" },
      { id: "str_2", name: "Other", domain: "other.myshopify.com" },
    ]);
    expect(body.session).toMatchObject({ source: "browser sign-in", renewable: true });
    expect(body.session.accessTokenExpiresAt).toBe(new Date(STORED.expiresAt).toISOString());
    // Four hours out, give or take the milliseconds the call itself took.
    expect(body.session.accessTokenExpiresInMinutes).toBeGreaterThanOrEqual(239);
    expect(body.session.accessTokenExpiresInMinutes).toBeLessThanOrEqual(240);
    expect(body.hermes).toEqual({
      baseUrl: "https://hermes-atlas.vajro.com",
      openApiDocsUrl: "https://hermes-atlas.vajro.com/v3/api-docs",
    });
  });

  it("never returns a token of any kind", async () => {
    const { client, auth } = await connect();
    auth!.store.save(STORED);

    const text = textOf(await whoami(client));

    expect(text).not.toContain("stored-acc");
    expect(text).not.toContain("stored-ref");
    // The Shopify storefront token rides on every store record from Hermes.
    expect(text).not.toContain("sf-SECRET");
    expect(text).not.toContain("sfAccessToken");
  });

  it("says nobody is signed in, and opens no browser to find out", async () => {
    const { client, opened, requests } = await connect();

    const body = JSON.parse(textOf(await whoami(client)));

    expect(body.signedIn).toBe(false);
    expect(opened).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("still answers with the profile when the store list cannot be read", async () => {
    const { client, auth } = await connect({
      stores: async () => {
        throw new HermesForbiddenError("/api/v1/users/me/stores");
      },
    });
    auth!.store.save(STORED);

    const body = JSON.parse(textOf(await whoami(client)));

    expect(body.user.id).toBe("usr_1");
    expect(body.stores).toBeNull();
  });

  it("falls back to /users/{id} when Hermes fails on /users/me", async () => {
    // Seen live: /users/me 500s inside Hermes for an account whose isAdmin is
    // null, while /users/{id} answers for the same user.
    const { client, auth, requests } = await connect({
      me: async () => {
        throw new HermesUnavailableError("/api/v1/users/me", new Error("getIsAdmin() is null"), 500);
      },
    });
    auth!.store.save(STORED);

    const result = await whoami(client);
    const body = JSON.parse(textOf(result));

    expect(result.isError).toBeFalsy();
    expect(body.user).toMatchObject({ id: "usr_1", name: "Deepan" });
    expect(body.userError).toBeUndefined();
    expect(requests.map((r) => r.path)).toContain("/api/v1/users/usr_1");
  });

  it("still answers with the store and session when no profile can be loaded", async () => {
    const { client } = await connect({
      env: { accessToken: "env-acc", storeId: "str_1" },
      me: async () => {
        throw new HermesUnavailableError("/api/v1/users/me", new Error("boom"), 500);
      },
    });

    const result = await whoami(client);
    const body = JSON.parse(textOf(result));

    expect(result.isError).toBeFalsy();
    expect(body.user).toBeNull();
    expect(body.userError).toContain("Hermes failed with 500 on /api/v1/users/me: boom");
    expect(body.store.id).toBe("str_1");
    expect(body.hermes.baseUrl).toBe("https://hermes-atlas.vajro.com");
  });

  it("reports a .env session as coming from .env", async () => {
    const { client } = await connect({ env: { accessToken: "env-acc", storeId: "str_1" } });

    const body = JSON.parse(textOf(await whoami(client)));

    expect(body.session).toMatchObject({
      source: ".env",
      renewable: false,
      accessTokenExpiresAt: null,
      accessTokenExpiresInMinutes: null,
    });
  });

  it("works for a caller's own credentials in a shared process", async () => {
    const { client, requests } = await connect({ auth: false });

    const body = JSON.parse(
      textOf(
        await whoami(client, {
          "com.superfans.hermes/accessToken": "caller-acc",
          "com.superfans.hermes/storeId": "str_1",
        })
      )
    );

    expect(body.session.source).toBe("request");
    expect(requests.every((r) => r.token === "caller-acc")).toBe(true);
  });
});

describe("hermes_logout", () => {
  it("is not offered by a process that owns no session", async () => {
    const { client } = await connect({ auth: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("hermes_logout");
    expect(names).toContain("hermes_whoami");
  });

  it("clears the saved sign-in, and the next call signs in again", async () => {
    const { client, auth, opened } = await connect();
    auth!.store.save(STORED);

    const result = await client.callTool({ name: "hermes_logout", arguments: {} });

    expect(textOf(result)).toContain("Signed out of Hermes (usr_1 on Shop)");
    expect(auth!.store.read()).toBeNull();
    expect(JSON.parse(textOf(await whoami(client))).signedIn).toBe(false);
    expect(opened).toEqual([]);
  });

  it("closes a sign-in still waiting in the browser", async () => {
    const { client, auth } = await connect();
    await client.callTool({ name: "hermes_setup", arguments: {} });
    expect(auth!.pending.current).toBeDefined();

    const result = await client.callTool({ name: "hermes_logout", arguments: {} });

    expect(textOf(result)).toContain("the sign-in waiting in the browser");
    await new Promise((r) => setTimeout(r, 0));
    expect(auth!.pending.current).toBeUndefined();
  });

  it("blanks the credentials in the loaded .env, and stops using them now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-envfile-"));
    const envFile = join(dir, ".env");
    writeFileSync(
      envFile,
      "# keep me\r\nHERMES_ACCESS_TOKEN=env-acc\r\nHERMES_STORE_ID=str_1\r\nHERMES_REFRESH_TOKEN=env-ref\r\nHERMES_BASE_URL=https://hermes-atlas.vajro.com\r\n"
    );
    const { client, auth } = await connect({
      env: { accessToken: "env-acc", storeId: "str_1", refreshToken: "env-ref" },
      envFile,
    });

    const result = await client.callTool({ name: "hermes_logout", arguments: {} });

    expect(textOf(result)).toContain("HERMES_ACCESS_TOKEN, HERMES_STORE_ID, HERMES_REFRESH_TOKEN");
    expect(readFileSync(envFile, "utf-8")).toBe(
      "# keep me\r\nHERMES_ACCESS_TOKEN=\r\nHERMES_STORE_ID=\r\nHERMES_REFRESH_TOKEN=\r\nHERMES_BASE_URL=https://hermes-atlas.vajro.com\r\n"
    );
    expect(auth!.envRetired).toBe(true);
    expect(JSON.parse(textOf(await whoami(client))).signedIn).toBe(false);
  });

  it("says so when the .env credentials came from somewhere it cannot edit", async () => {
    const { client, auth } = await connect({ env: { accessToken: "env-acc", storeId: "str_1" } });

    const result = await client.callTool({ name: "hermes_logout", arguments: {} });

    expect(textOf(result)).toContain("not in a file it can edit");
    expect(auth!.envRetired).toBe(true);
  });

  it("forgets renewed tokens held in memory", async () => {
    const tokens = new TokenCache("https://hermes.test");
    const clear = vi.spyOn(tokens, "clear");
    const { client, auth } = await connect({ tokens });
    auth!.store.save(STORED);

    await client.callTool({ name: "hermes_logout", arguments: {} });

    expect(clear).toHaveBeenCalledOnce();
  });

  it("reports nothing to clear when nobody was signed in", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "hermes_logout", arguments: {} });
    expect(textOf(result)).toContain("Nobody was signed in");
  });
});

describe("clearEnvCredentials", () => {
  it("returns nothing and writes nothing for a missing file", () => {
    expect(clearEnvCredentials(join(tmpdir(), "does-not-exist", ".env"))).toEqual([]);
  });

  it("handles `export` lines and leaves already-empty keys unreported", () => {
    const envFile = join(mkdtempSync(join(tmpdir(), "hermes-envfile-")), ".env");
    writeFileSync(envFile, "export HERMES_ACCESS_TOKEN=abc\nHERMES_STORE_ID=\n");

    expect(clearEnvCredentials(envFile)).toEqual(["HERMES_ACCESS_TOKEN"]);
    expect(readFileSync(envFile, "utf-8")).toBe("export HERMES_ACCESS_TOKEN=\nHERMES_STORE_ID=\n");
  });
});
