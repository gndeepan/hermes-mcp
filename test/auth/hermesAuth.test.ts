import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAccessToken, webLogin } from "../../src/auth/hermesAuth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webLogin", () => {
  it("sends Basic Auth plus the domain body, and unwraps {data}", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/web");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from("me@x.com:secret", "utf-8").toString("base64")}`
      );
      expect(JSON.parse(init.body as string)).toEqual({ domain: "store.myshopify.com" });
      return new Response(
        JSON.stringify({
          data: {
            userId: "u1",
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 1_800_000_000,
            isAdmin: false,
            stores: [{ id: "s1", name: "My Store", domain: "store.myshopify.com" }],
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webLogin("https://hermes.test", "store.myshopify.com", "me@x.com", "secret");

    expect(result.accessToken).toBe("a");
    expect(result.stores).toEqual([{ id: "s1", name: "My Store", domain: "store.myshopify.com" }]);
  });

  it("reads an unenveloped response body too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              userId: "u1",
              accessToken: "a",
              refreshToken: "r",
              expiresAt: 1_800_000_000,
              isAdmin: false,
              stores: [],
            }),
            { status: 200 }
          )
      )
    );
    const result = await webLogin("https://hermes.test", "d", "e", "p");
    expect(result.accessToken).toBe("a");
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(webLogin("https://hermes.test", "d", "e", "p")).rejects.toThrow(/401/);
  });

  it("never includes the password in a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    try {
      await webLogin("https://hermes.test", "d", "me@x.com", "hunter2");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }
  });
});

describe("refreshAccessToken", () => {
  it("sends the refresh token and unwraps {data}", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/refresh");
      expect(JSON.parse(init.body as string)).toEqual({ refreshToken: "r1" });
      return new Response(
        JSON.stringify({ data: { accessToken: "a2", refreshToken: "r2", expiresAt: 1_800_000_000_000 } }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshAccessToken("https://hermes.test", "r1");

    expect(result).toEqual({ accessToken: "a2", refreshToken: "r2", expiresAt: 1_800_000_000_000 });
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(refreshAccessToken("https://hermes.test", "bad")).rejects.toThrow(/401/);
  });
});
