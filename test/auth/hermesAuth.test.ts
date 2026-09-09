import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAccessToken, sendEmailOtp, storeLogin, webLogin } from "../../src/auth/hermesAuth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendEmailOtp", () => {
  it("posts the email and sends no Authorization header", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/otp/email/send");
      expect(init.body).toBe(JSON.stringify({ email: "me@x.com" }));
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: { message: "sent" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendEmailOtp("https://hermes.test", "me@x.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("webLogin", () => {
  it("sends Basic base64(email:otp) with an empty body and maps the response", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/web");
      expect(init.body).toBe("{}");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("me@x.com:123456", "utf-8").toString("base64")}`
      );
      return new Response(
        JSON.stringify({
          data: {
            userId: "u1",
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 1_800_000_000_000,
            isAdmin: false,
            stores: [{ id: "s1", name: "Store One", domain: "one.myshopify.com" }],
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webLogin("https://hermes.test", "me@x.com", "123456");
    expect(result.accessToken).toBe("a");
    expect(result.stores).toHaveLength(1);
  });

  it("never includes the one-time code in a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    const error = await webLogin("https://hermes.test", "me@x.com", "123456").catch(
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("123456");
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
    const result = await webLogin("https://hermes.test", "me@x.com", "123456");
    expect(result.accessToken).toBe("a");
  });
});

describe("storeLogin", () => {
  it("sends the store id as a header with an empty body", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/stores/login");
      expect(init.body).toBe("{}");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer a");
      expect(headers["X-Store-Id"]).toBe("s1");
      return new Response(JSON.stringify({ data: { message: "ok" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await storeLogin("https://hermes.test", "a", "s1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(storeLogin("https://hermes.test", "a", "s1")).rejects.toThrow(/403/);
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
