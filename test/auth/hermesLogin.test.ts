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
