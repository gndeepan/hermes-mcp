import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesUnavailableError, SessionExpiredError } from "../src/errors.js";
import { TokenCache, refreshAccessToken } from "../src/tokenRefresh.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const tokens = (suffix: string, expiresAt = 2_000_000_000_000): string =>
  JSON.stringify({
    data: {
      userId: "usr_1",
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      expiresAt,
      stores: [],
      isAdmin: true,
    },
  });

describe("refreshAccessToken", () => {
  it("posts only the refresh token, with no Authorization header", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/refresh");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ refreshToken: "r1" });
      // The endpoint authenticates by the refresh token in the body. Sending
      // the dead access token alongside it is at best noise.
      expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization");
      return new Response(tokens("2", 1_790_001_288_734), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await refreshAccessToken("https://hermes.test", "r1")).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 1_790_001_288_734,
    });
  });

  it("keeps the refresh token it was given when Hermes does not rotate it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { accessToken: "a2", expiresAt: 2_000_000_000_000 } }), {
            status: 200,
          })
      )
    );

    expect((await refreshAccessToken("https://hermes.test", "r1")).refreshToken).toBe("r1");
  });

  it("raises SessionExpiredError when the refresh token itself is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    await expect(refreshAccessToken("https://hermes.test", "r1")).rejects.toBeInstanceOf(
      SessionExpiredError
    );
  });

  it("raises SessionExpiredError, not a parse failure, on a response with no access token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));

    await expect(refreshAccessToken("https://hermes.test", "r1")).rejects.toBeInstanceOf(
      SessionExpiredError
    );
  });

  it("reports an unreachable auth host as unavailable, not as an expired session", async () => {
    // A network fault is not evidence the session died. Reporting it as
    // SessionExpiredError would tell a signed-in merchant to sign in again.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    await expect(refreshAccessToken("https://hermes.test", "r1")).rejects.toBeInstanceOf(
      HermesUnavailableError
    );
  });
});

describe("TokenCache", () => {
  it("refreshes once and serves later calls for the same session from memory", async () => {
    const fetchMock = vi.fn(async () => new Response(tokens("2"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new TokenCache("https://hermes.test");

    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-2");
    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve one session's token to another refresh token", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(tokens(String((n += 1))), { status: 200 }))
    );
    const cache = new TokenCache("https://hermes.test");

    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-1");
    expect((await cache.accessTokenFor("r2")).accessToken).toBe("access-2");
  });

  it("collapses concurrent refreshes of one session into a single call", async () => {
    const fetchMock = vi.fn(async () => new Response(tokens("2"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new TokenCache("https://hermes.test");

    const all = await Promise.all(Array.from({ length: 10 }, () => cache.accessTokenFor("r1")));

    expect(all.every((t) => t.accessToken === "access-2")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a later call retry after a failed refresh rather than caching the failure", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? new Response("nope", { status: 500 })
          : new Response(tokens("2"), { status: 200 });
      })
    );
    const cache = new TokenCache("https://hermes.test");

    await expect(cache.accessTokenFor("r1")).rejects.toBeInstanceOf(HermesUnavailableError);
    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-2");
  });

  it("refreshes again once the cached token is inside the expiry skew", async () => {
    const now = 1_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        // Each token is good for two minutes, so the first falls inside the
        // 60s skew before it is actually dead.
        return new Response(tokens(String(n), Date.now() + 120_000), { status: 200 });
      })
    );
    const cache = new TokenCache("https://hermes.test");

    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-1");
    vi.setSystemTime(now + 70_000);
    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-2");
  });

  it("follows a rotated refresh token, so the new one is a cache hit", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => new Response(tokens(String((n += 1))), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new TokenCache("https://hermes.test");

    expect((await cache.accessTokenFor("r1")).refreshToken).toBe("refresh-1");

    // The caller now holds "refresh-1". It must not cost another round trip.
    expect((await cache.accessTokenFor("refresh-1")).accessToken).toBe("access-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forces a round trip when a token was rejected, ignoring the cached copy", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => new Response(tokens(String((n += 1))), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new TokenCache("https://hermes.test");

    expect((await cache.accessTokenFor("r1")).accessToken).toBe("access-1");
    expect((await cache.accessTokenFor("r1", { force: true })).accessToken).toBe("access-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest sessions rather than growing without bound", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => new Response(tokens(String((n += 1))), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new TokenCache("https://hermes.test", { maxEntries: 2 });

    await cache.accessTokenFor("r1");
    await cache.accessTokenFor("r2");
    await cache.accessTokenFor("r3");

    expect(cache.size).toBeLessThanOrEqual(2);
    // r1 was evicted, so asking for it again costs a round trip.
    await cache.accessTokenFor("r1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never keys the cache by the raw refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(tokens("2"), { status: 200 })));
    const cache = new TokenCache("https://hermes.test");
    await cache.accessTokenFor("r1-secret");

    expect(cache.keys().join(" ")).not.toContain("r1-secret");
  });
});
