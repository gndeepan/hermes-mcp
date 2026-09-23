import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../../src/auth/credentialStore.js";
import { startLoginServer, type PendingLogin } from "../../src/auth/loginServer.js";
import type { HermesLogin, LoginSession } from "../../src/auth/hermesLogin.js";
import { createLogger } from "../../src/logging.js";

const logger = createLogger({ logLevel: "silent" });

const SESSION: LoginSession = {
  accessToken: "acc-SECRET",
  refreshToken: "ref-SECRET",
  expiresAt: 1790000000000,
  userId: "usr_1",
  stores: [{ id: "str_1", name: "SuperHero-vjro" }],
  isAdmin: false,
};

const fakeLogin = (overrides: Partial<HermesLogin> = {}): HermesLogin => ({
  sendCode: vi.fn(async () => undefined),
  verifyCode: vi.fn(async () => SESSION),
  searchStores: vi.fn(async () => []),
  ...overrides,
});

let pending: PendingLogin | undefined;
afterEach(() => pending?.close());

const start = async (login: HermesLogin, store = new CredentialStore(mkdtempSync(join(tmpdir(), "hermes-login-")))) => {
  pending = await startLoginServer({ login, store, logger, timeoutMs: 30_000 });
  const base = new URL(pending.url);
  return { pending, store, base, nonce: base.searchParams.get("k")! };
};

/** A form POST, the way the browser makes it. */
const post = (base: URL, path: string, fields: Record<string, string>) =>
  fetch(new URL(path, base), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

describe("the login server", () => {
  it("listens on loopback only, and says so in the URL it hands back", async () => {
    const { pending: p } = await start(fakeLogin());
    expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=/);
  });

  it("serves the email screen to a request carrying the nonce", async () => {
    const { pending: p } = await start(fakeLogin());
    const body = await (await fetch(p.url)).text();
    expect(body).toContain("Sign in to Hermes");
    expect(body).toContain('name="email"');
  });

  it("refuses a request without the nonce, revealing nothing", async () => {
    // Otherwise any other process on the machine could drive the login.
    const { base } = await start(fakeLogin());
    const res = await fetch(new URL("/", base));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("");
  });

  it("refuses a request carrying the wrong nonce", async () => {
    const { base } = await start(fakeLogin());
    const res = await fetch(new URL("/?k=not-the-nonce", base));
    expect(res.status).toBe(403);
  });

  it("walks email to code to done, and saves the session", async () => {
    const login = fakeLogin();
    const { base, nonce, store } = await start(login);

    const emailRes = await post(base, "/email", { k: nonce, email: "a@b.com" });
    expect(emailRes.status).toBe(303);
    expect(login.sendCode).toHaveBeenCalledWith("a@b.com");

    const otpRes = await post(base, "/otp", { k: nonce, code: "123456" });
    expect(login.verifyCode).toHaveBeenCalledWith("a@b.com", "123456");
    expect(otpRes.status).toBe(200);
    expect(await otpRes.text()).toContain("You're signed in");

    // One store selects itself — the merchant was never asked.
    expect(store.read()).toMatchObject({ storeId: "str_1", storeName: "SuperHero-vjro", userId: "usr_1" });
  });

  it("asks which store when there is more than one", async () => {
    const login = fakeLogin({
      verifyCode: vi.fn(async () => ({
        ...SESSION,
        stores: [
          { id: "str_1", name: "One" },
          { id: "str_2", name: "Two" },
        ],
      })),
    });
    const { base, nonce, store } = await start(login);

    await post(base, "/email", { k: nonce, email: "a@b.com" });
    const otpRes = await post(base, "/otp", { k: nonce, code: "123456" });
    expect(otpRes.status).toBe(303);

    const picker = await (await fetch(new URL(`/store?k=${nonce}`, base))).text();
    expect(picker).toContain("One");
    expect(picker).toContain("Two");

    await post(base, "/store", { k: nonce, storeId: "str_2" });
    expect(store.read()).toMatchObject({ storeId: "str_2", storeName: "Two" });
  });

  it("gives an admin with no stores a field rather than an empty list", async () => {
    const login = fakeLogin({
      verifyCode: vi.fn(async () => ({ ...SESSION, stores: [], isAdmin: true })),
    });
    const { base, nonce, store } = await start(login);

    await post(base, "/email", { k: nonce, email: "a@b.com" });
    await post(base, "/otp", { k: nonce, code: "123456" });

    const picker = await (await fetch(new URL(`/store?k=${nonce}`, base))).text();
    expect(picker).toContain('name="storeId"');

    await post(base, "/store", { k: nonce, storeId: "str_typed" });
    expect(store.read()).toMatchObject({ storeId: "str_typed" });
  });

  it("stops the login when the account has no stores and is not an admin", async () => {
    const login = fakeLogin({
      verifyCode: vi.fn(async () => ({ ...SESSION, stores: [], isAdmin: false })),
    });
    const { base, nonce, store } = await start(login);

    await post(base, "/email", { k: nonce, email: "a@b.com" });
    const res = await post(base, "/otp", { k: nonce, code: "123456" });

    expect(await res.text()).toContain("isn't attached to any store");
    expect(store.read()).toBeNull();
  });

  it("shows Hermes' own message when the code is wrong, and does not save", async () => {
    const login = fakeLogin({
      verifyCode: vi.fn(async () => {
        throw new Error("That code has expired");
      }),
    });
    const { base, nonce, store } = await start(login);

    await post(base, "/email", { k: nonce, email: "a@b.com" });
    const res = await post(base, "/otp", { k: nonce, code: "000000" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That code has expired");
    expect(store.read()).toBeNull();
  });

  it("sends the merchant back to the start if they jump to a later screen", async () => {
    const { base, nonce } = await start(fakeLogin());
    const res = await fetch(new URL(`/otp?k=${nonce}`, base), { redirect: "manual" });
    expect(res.status).toBe(303);
  });

  it("stops itself once the login is done", async () => {
    const { base, nonce, pending: p } = await start(fakeLogin());
    await post(base, "/email", { k: nonce, email: "a@b.com" });
    await post(base, "/otp", { k: nonce, code: "123456" });

    // This is the behaviour asked for: the server exists for the login and not
    // one moment longer.
    const saved = await p.finished;
    expect(saved).toMatchObject({ storeId: "str_1" });
    await expect(fetch(new URL("/", base))).rejects.toThrow();
  });

  it("closes itself when nobody signs in before the deadline", async () => {
    const store = new CredentialStore(mkdtempSync(join(tmpdir(), "hermes-login-")));
    pending = await startLoginServer({ login: fakeLogin(), store, logger, timeoutMs: 120 });
    const base = new URL(pending.url);

    expect(await pending.finished).toBeNull();
    await expect(fetch(new URL("/", base))).rejects.toThrow();
  });

  it("never puts a token in a page, a redirect or a URL", async () => {
    // The property the whole design rests on: the browser handles an email and
    // a code, and never a credential.
    const { base, nonce, pending: p } = await start(fakeLogin());
    const seen: string[] = [p.url];

    seen.push(await (await fetch(p.url)).text());
    const emailRes = await post(base, "/email", { k: nonce, email: "a@b.com" });
    seen.push(emailRes.headers.get("location") ?? "", await emailRes.text());
    seen.push(await (await fetch(new URL(`/otp?k=${nonce}`, base))).text());
    const otpRes = await post(base, "/otp", { k: nonce, code: "123456" });
    seen.push(otpRes.headers.get("location") ?? "", await otpRes.text());

    for (const text of seen) {
      expect(text).not.toContain("acc-SECRET");
      expect(text).not.toContain("ref-SECRET");
    }
  });
});

describe("an admin choosing a store", () => {
  const ADMIN = { ...SESSION, stores: [], isAdmin: true };

  /** Signs in as far as the store screen. */
  const atStorePicker = async (login: HermesLogin) => {
    const started = await start(login);
    await post(started.base, "/email", { k: started.nonce, email: "a@b.com" });
    await post(started.base, "/otp", { k: started.nonce, code: "12345678" });
    return started;
  };

  const search = (base: URL, nonce: string, q: string) =>
    fetch(new URL(`/stores/search?k=${nonce}&q=${encodeURIComponent(q)}`, base));

  it("gets a live search box, as the dashboard gives an admin", async () => {
    const { base, nonce } = await atStorePicker(fakeLogin({ verifyCode: vi.fn(async () => ADMIN) }));

    const picker = await (await fetch(new URL(`/store?k=${nonce}`, base))).text();

    expect(picker).toContain('id="q"');
    expect(picker).toContain("Search a Store");
    expect(picker).toContain("/stores/search");
  });

  it("searches Hermes with the session's token, and names the chosen store from the results", async () => {
    const searchStores = vi.fn(async () => [
      { storeId: "str_9", name: "Found Store", appId: 4242, enabled: true },
      { storeId: "", name: "Legacy Store", appId: 17, enabled: false },
    ]);
    const { base, nonce, store } = await atStorePicker(
      fakeLogin({ verifyCode: vi.fn(async () => ADMIN), searchStores })
    );

    const res = await search(base, nonce, "found");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(searchStores).toHaveBeenCalledWith("acc-SECRET", "found");
    expect(body.stores).toHaveLength(2);
    // The token went to Hermes from this process; it never comes back to the page.
    expect(JSON.stringify(body)).not.toContain("SECRET");

    // The name comes from the search, not from anything the form could claim.
    await post(base, "/store", { k: nonce, storeId: "str_9", storeName: "Spoofed" });
    expect(store.read()).toMatchObject({ storeId: "str_9", storeName: "Found Store" });
  });

  it("refuses the search to anyone who is not an admin", async () => {
    const searchStores = vi.fn(async () => []);
    const { base, nonce } = await atStorePicker(
      fakeLogin({ verifyCode: vi.fn(async () => ({ ...SESSION, stores: [{ id: "a", name: "A" }, { id: "b", name: "B" }] })), searchStores })
    );

    expect((await search(base, nonce, "x")).status).toBe(403);
    expect(searchStores).not.toHaveBeenCalled();
  });

  it("refuses the search without the nonce", async () => {
    const { base } = await atStorePicker(fakeLogin({ verifyCode: vi.fn(async () => ADMIN) }));
    expect((await search(base, "wrong", "x")).status).toBe(403);
  });

  it("answers a failed search with a message the page can show", async () => {
    const { base, nonce } = await atStorePicker(
      fakeLogin({
        verifyCode: vi.fn(async () => ADMIN),
        searchStores: vi.fn(async () => {
          throw new Error("boom");
        }),
      })
    );

    const res = await search(base, nonce, "x");

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Couldn't search stores");
  });
});

describe("resending the code", () => {
  it("sends a new code to the same address and says so", async () => {
    const login = fakeLogin();
    const { base, nonce } = await start(login);
    await post(base, "/email", { k: nonce, email: "a@b.com" });

    const res = await post(base, "/resend", { k: nonce });

    expect(await res.text()).toContain("We sent you a new code.");
    expect(login.sendCode).toHaveBeenCalledTimes(2);
    expect(login.sendCode).toHaveBeenLastCalledWith("a@b.com");
  });

  it("goes back to the email screen when there is no address yet", async () => {
    const { base, nonce } = await start(fakeLogin());
    const res = await post(base, "/resend", { k: nonce });
    expect(res.status).toBe(303);
  });
});
