import { afterEach, describe, expect, it, vi } from "vitest";
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

const loginResult = (stores: WebLoginResult["stores"], isAdmin = false): WebLoginResult => ({
  userId: "u1",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 1_800_000_000_000,
  isAdmin,
  stores,
});

/** What Hermes returns for an internal admin: no assigned stores, `isAdmin` set. */
const adminLogin = async () => loginResult([], true);

const singleStoreLogin = async () =>
  loginResult([{ id: "s1", name: "Store One", domain: "one.myshopify.com" }]);

const noopSelectStore = async () => {};

const postJson = (port: number, path: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("startLoginServer", () => {
  it("serves the email form on GET /", async () => {
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store: fakeStore(),
      selectStore: noopSelectStore,
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('name="email"');
    expect(text).not.toContain('name="domain"');
    expect(text).not.toContain('name="password"');
  });

  it("emails a code and shows the code form", async () => {
    const sendOtp = vi.fn(async () => {});
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store: fakeStore(),
      sendOtp,
      selectStore: noopSelectStore,
    });

    const res = await postJson(server.port, "/request-otp", { email: "me@x.com" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("one-time code");
    expect(sendOtp).toHaveBeenCalledWith(expect.any(String), "me@x.com");
  });

  it("re-renders the code form with an error when the code is wrong", async () => {
    const login = vi.fn(async () => {
      throw new Error("Hermes /api/v1/auth/web failed with status 401");
    });
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store: fakeStore(),
      login,
      selectStore: noopSelectStore,
    });

    const res = await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "000000" });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("one-time code");
    expect(body).toContain("401");
  });

  it("registers the chosen store before persisting", async () => {
    const selectStore = vi.fn(async () => {});
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      selectStore,
      login: singleStoreLogin,
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });

    expect(selectStore).toHaveBeenCalledWith(expect.any(String), "a", "s1");
    expect(store.written).toHaveLength(1);
  });

  it("persists nothing when registering the store fails", async () => {
    const selectStore = vi.fn(async () => {
      throw new Error("Hermes /api/v1/auth/stores/login failed with status 403");
    });
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      selectStore,
      login: singleStoreLogin,
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });

    expect(store.written).toHaveLength(0);
    // Nothing will retry the failed registration for us, and login.ts is already awaiting
    // completion — the CLI must not be left hanging.
    await expect(server.waitForCompletion()).resolves.toBe(false);
  });

  it("persists credentials and completes when the login returns exactly one store", async () => {
    const store = fakeStore();
    const login = async () => loginResult([{ id: "s1", name: "My Store", domain: "one.myshopify.com" }]);
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      selectStore: noopSelectStore,
    });

    const response = await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });

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
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      selectStore: noopSelectStore,
    });

    const pickerHtml = await (
      await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" })
    ).text();
    // One dropdown to choose from, not a wall of buttons.
    expect(pickerHtml).toContain('<select name="storeId"');
    expect(pickerHtml).toContain('<option value="s1">Store One');
    expect(pickerHtml).toContain('<option value="s2">Store Two');
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
      selectStore: noopSelectStore,
      presetStoreId: "s2",
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });

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
      selectStore: noopSelectStore,
      presetStoreId: "nope",
    });

    const response = await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
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
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      selectStore: noopSelectStore,
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
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
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      selectStore: noopSelectStore,
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
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
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      selectStore: noopSelectStore,
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "me@x.com", otp: "123456" }).toString(),
    });

    expect(response.status).toBe(200);
    expect(store.written).toHaveLength(1);
  });

  it("re-renders the form with the error when login fails, without persisting or crashing", async () => {
    const store = fakeStore();
    const login = async () => {
      throw new Error("Hermes /api/v1/auth/web failed with status 401");
    };
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      selectStore: noopSelectStore,
    });

    const text = await (
      await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "wrong" })
    ).text();

    expect(text).toContain("401");
    expect(text).toContain('name="otp"');
    expect(store.written).toHaveLength(0);

    const stillUp = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(stillUp.status).toBe(200);
  });

  it("rejects /select-store before a successful login", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      selectStore: noopSelectStore,
    });

    const response = await postJson(server.port, "/select-store", { storeId: "s1" });

    expect(response.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it("offers a search box instead of an empty picker when an admin has no assigned stores", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore: noopSelectStore,
    });

    const response = await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    const body = await response.text();

    expect(response.status).toBe(200);
    // The old behavior was a "Pick a store" page with nothing on it, which left
    // the CLI waiting on a completion that could never come.
    expect(body).toContain('action="/search-stores"');
    expect(body).toContain('name="query"');
    expect(store.written).toHaveLength(0);
  });

  it("finds a store by search and persists the one picked from the results", async () => {
    const store = fakeStore();
    const selectStore = vi.fn(async () => {});
    const findStores = vi.fn(async () => [{ id: "s9", name: "Acme", appId: 42 }]);
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore,
      findStores,
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    const results = await (await postJson(server.port, "/search-stores", { query: "acme" })).text();

    expect(findStores).toHaveBeenCalledWith(expect.any(String), "a", "acme");
    expect(results).toContain('<option value="s9">Acme — app 42</option>');
    // The search box stays, keyed with the last query, so it can be refined.
    expect(results).toContain('value="acme"');

    const response = await postJson(server.port, "/select-store", { storeId: "s9" });

    expect(response.status).toBe(200);
    expect(await server.waitForCompletion()).toBe(true);
    expect(selectStore).toHaveBeenCalledWith(expect.any(String), "a", "s9");
    expect(store.written[0]).toMatchObject({ storeId: "s9" });
  });

  it("still refuses a storeId Hermes never returned, even once searching is available", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore: noopSelectStore,
      findStores: async () => [{ id: "s9", name: "Acme" }],
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    await postJson(server.port, "/search-stores", { query: "acme" });
    const response = await postJson(server.port, "/select-store", { storeId: "s-never-seen" });

    expect(response.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it("shows a store with no modernization id but refuses to persist it", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore: noopSelectStore,
      findStores: async () => [{ id: "", name: "Legacy Co", appId: 7 }],
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    const results = await (await postJson(server.port, "/search-stores", { query: "legacy" })).text();

    // Named, so the operator knows the search found it — but with no dropdown to
    // submit, because there is no store id to act on.
    expect(results).toContain("Legacy Co");
    expect(results).toContain("modernization is not enabled");
    expect(results).not.toContain('action="/select-store"');

    const response = await postJson(server.port, "/select-store", { storeId: "" });

    expect(response.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it("puts usable and unusable search hits in one dropdown, only the usable ones selectable", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore: noopSelectStore,
      findStores: async () => [
        { id: "s9", name: "Acme", appId: 42 },
        { id: "", name: "Legacy Co", appId: 7 },
      ],
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    const results = await (await postJson(server.port, "/search-stores", { query: "co" })).text();

    expect(results).toContain('<option value="s9">Acme — app 42</option>');
    expect(results).toContain('<option value="" disabled>Legacy Co — app 7 (modernization not enabled)</option>');
  });

  it("keeps the picker up when a store search fails", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore: noopSelectStore,
      findStores: async () => {
        throw new Error("Hermes /api/v1/stores/search failed with status 500");
      },
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    const response = await postJson(server.port, "/search-stores", { query: "acme" });
    const body = await response.text();

    // Only the search failed — the session is still good, so the operator must be
    // able to search again rather than being sent back through the OTP.
    expect(response.status).toBe(200);
    expect(body).toContain("500");
    expect(body).toContain('action="/search-stores"');
  });

  it("refuses to search for a non-admin account", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: async () =>
        loginResult([
          { id: "s1", name: "Store One", domain: "one.myshopify.com" },
          { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
        ]),
      selectStore: noopSelectStore,
      findStores: vi.fn(),
    });

    const picker = await (
      await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" })
    ).text();
    // The picker is populated (so this is not vacuous), and carries no search box.
    expect(picker).toContain('action="/select-store"');
    expect(picker).not.toContain('action="/search-stores"');

    const response = await postJson(server.port, "/search-stores", { query: "acme" });
    expect(response.status).toBe(400);
  });

  it("ends the login when a non-admin account has no stores at all", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: async () => loginResult([]),
      selectStore: noopSelectStore,
    });

    const response = await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toContain("cannot access any store");
    expect(body).not.toContain('action="/select-store"');
    expect(store.written).toHaveLength(0);
    // Nothing on that page can advance the login, so the CLI must not wait on it.
    expect(await server.waitForCompletion()).toBe(false);
  });

  it("accepts --store for an admin, whose empty login list is not a list of what they may use", async () => {
    const store = fakeStore();
    const selectStore = vi.fn(async () => {});
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore,
      presetStoreId: "s-admin-picked",
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });

    expect(await server.waitForCompletion()).toBe(true);
    expect(selectStore).toHaveBeenCalledWith(expect.any(String), "a", "s-admin-picked");
    expect(store.written[0]).toMatchObject({ storeId: "s-admin-picked" });
  });

  it("persists nothing when Hermes rejects an admin's --store", async () => {
    const store = fakeStore();
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login: adminLogin,
      selectStore: async () => {
        throw new Error("Hermes /api/v1/auth/stores/login failed with status 403");
      },
      presetStoreId: "s-not-allowed",
    });

    await postJson(server.port, "/verify-otp", { email: "me@x.com", otp: "123456" });

    // With no list to check an admin's flag against, the store-registration call is
    // the gate — and it runs before anything is written.
    expect(store.written).toHaveLength(0);
    expect(await server.waitForCompletion()).toBe(false);
  });

  it("binds to 127.0.0.1 only", async () => {
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store: fakeStore(),
      selectStore: noopSelectStore,
    });

    // The resolved bind address, not just "something answers on loopback" —
    // a server bound to 0.0.0.0 answers on 127.0.0.1 identically.
    expect(server.address).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
  });
});
