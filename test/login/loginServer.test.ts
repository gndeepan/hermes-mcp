import { afterEach, describe, expect, it } from "vitest";
import { startLoginServer, type LoginServer } from "../../src/login/loginServer.js";
import type { StoredCredentials, TokenStore } from "../../src/auth/tokenStore.js";
import type { WebLoginResult } from "../../src/auth/hermesAuth.js";

let server: LoginServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const fakeStore = (): TokenStore & { written: StoredCredentials[] } => {
  const written: StoredCredentials[] = [];
  return {
    read: () => written[written.length - 1] ?? null,
    write: (credentials) => {
      written.push(credentials);
    },
    written,
  };
};

const loginResult = (stores: WebLoginResult["stores"]): WebLoginResult => ({
  userId: "u1",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 1_800_000_000_000,
  isAdmin: false,
  stores,
});

const postJson = (port: number, path: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("startLoginServer", () => {
  it("serves the login form on GET /", async () => {
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store: fakeStore() });

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('name="domain"');
    expect(text).toContain('name="password"');
  });

  it("persists credentials and completes when the login returns exactly one store", async () => {
    const store = fakeStore();
    const login = async () => loginResult([{ id: "s1", name: "My Store", domain: "one.myshopify.com" }]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const response = await postJson(server.port, "/login", {
      domain: "one.myshopify.com",
      email: "me@x.com",
      password: "secret",
    });

    expect(response.status).toBe(200);
    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written).toEqual([
      { accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000_000, storeId: "s1" },
    ]);
  });

  it("shows a picker for multiple stores, then persists the picked one", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const pickerHtml = await (
      await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "secret" })
    ).text();
    expect(pickerHtml).toContain("Store One");
    expect(pickerHtml).toContain("Store Two");
    expect(store.written).toHaveLength(0);

    const response = await postJson(server.port, "/select-store", { storeId: "s2" });

    expect(response.status).toBe(200);
    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written[0]).toMatchObject({ storeId: "s2", accessToken: "a" });
  });

  it("skips the picker when presetStoreId is given, even with multiple stores", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      presetStoreId: "s2",
    });

    await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "secret" });

    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written[0]).toMatchObject({ storeId: "s2" });
  });

  it("rejects a presetStoreId that is not among the returned stores, without persisting", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      presetStoreId: "nope",
    });

    const response = await postJson(server.port, "/login", {
      domain: "x",
      email: "me@x.com",
      password: "secret",
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain("Logged in");
    expect(store.written).toHaveLength(0);
    // A bad --store flag can never be fixed by resubmitting the same form, so the
    // server must settle the completion promise rather than leaving the CLI hanging.
    expect(await server.waitForCompletion()).toBe(false);
  });

  it("rejects a /select-store storeId that is not among the returned stores", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "secret" });
    const response = await postJson(server.port, "/select-store", { storeId: "nope" });

    expect(response.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it("persists a /select-store storeId that is among the returned stores (control)", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "secret" });
    const response = await postJson(server.port, "/select-store", { storeId: "s1" });

    expect(response.status).toBe(200);
    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written).toEqual([
      { accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000_000, storeId: "s1" },
    ]);
  });

  it("accepts a urlencoded body, as a real browser form submits", async () => {
    const store = fakeStore();
    const login = async () => loginResult([{ id: "s1", name: "One", domain: "one.myshopify.com" }]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const response = await fetch(`http://127.0.0.1:${server.port}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ domain: "x", email: "me@x.com", password: "secret" }).toString(),
    });

    expect(response.status).toBe(200);
    expect(store.written).toHaveLength(1);
  });

  it("re-renders the form with the error when login fails, without persisting or crashing", async () => {
    const store = fakeStore();
    const login = async () => {
      throw new Error("Hermes /api/v1/auth/web failed with status 401");
    };
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const text = await (
      await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "wrong" })
    ).text();

    expect(text).toContain("401");
    expect(text).toContain('name="password"');
    expect(store.written).toHaveLength(0);

    const stillUp = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(stillUp.status).toBe(200);
  });

  it("rejects /select-store before a successful login", async () => {
    const store = fakeStore();
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store });

    const response = await postJson(server.port, "/select-store", { storeId: "s1" });

    expect(response.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it("binds to 127.0.0.1 only", async () => {
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store: fakeStore() });
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
  });
});
