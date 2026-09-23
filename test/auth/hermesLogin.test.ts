import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHermesLogin } from "../../src/auth/hermesLogin.js";
import { HermesRejectedError } from "../../src/errors.js";

const BASE = "https://hermes.test";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe("HttpHermesLogin.verifyCode", () => {
  it("logs in the way the dashboard does: POST /api/v1/auth/web with Basic email:otp", async () => {
    const fetchMock = respond(201, {
      data: {
        userId: "usr_1",
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: 1_900_000_000_000,
        stores: [{ id: "str_1", name: "Shop" }],
        isAdmin: false,
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await new HttpHermesLogin(BASE).verifyCode("a@b.com", "123456");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/v1/auth/web`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("a@b.com:123456").toString("base64")}`);
    // The code travels in the header only, never in the body.
    expect(init.body).toBe("{}");
    expect(session).toMatchObject({ userId: "usr_1", accessToken: "acc", refreshToken: "ref" });
    expect(session.stores).toEqual([{ id: "str_1", name: "Shop" }]);
  });

  it("surfaces a wrong code as Hermes' own rejection", async () => {
    vi.stubGlobal("fetch", respond(401, { error: { message: "Invalid credentials" } }));

    const err = await new HttpHermesLogin(BASE).verifyCode("a@b.com", "000000").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HermesRejectedError);
    expect((err as Error).message).toContain("Invalid credentials");
  });
});

describe("HttpHermesLogin.searchStores", () => {
  it("searches the way the dashboard does, and drops the storefront token", async () => {
    const fetchMock = respond(200, {
      data: [
        { storeId: "", name: "Legacy", appId: 17, tenant: 1, sfAccessToken: "sf-1" },
        { storeId: "str_9", name: "Found", appId: 4242, tenant: 1, sfAccessToken: "sf-2" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const stores = await new HttpHermesLogin(BASE).searchStores("acc", "Found");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe("/api/v1/stores/search");
    expect(Object.fromEntries(u.searchParams)).toEqual({ dto: "found", query: "found", type: "TAG" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer acc");
    // Usable first, and nothing but what the picker shows.
    expect(stores).toEqual([
      { storeId: "str_9", name: "Found", appId: 4242, enabled: true },
      { storeId: "", name: "Legacy", appId: 17, enabled: false },
    ]);
    expect(JSON.stringify(stores)).not.toContain("sf-");
  });

  it("searches by App ID when the term is all digits", async () => {
    const fetchMock = respond(200, { data: [] });
    vi.stubGlobal("fetch", fetchMock);

    await new HttpHermesLogin(BASE).searchStores("acc", "4242");

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get("type")).toBe("APPID");
  });
});
