import { describe, expect, it } from "vitest";
import { MissingCredentialsError } from "../src/errors.js";
import {
  ACCESS_TOKEN_KEY,
  EXPIRES_AT_KEY,
  REFRESH_TOKEN_KEY,
  REQUEST_ID_KEY,
  STORE_ID_KEY,
  headersFor,
  userContextFrom,
} from "../src/userContext.js";

const envFallback = { accessToken: "env-token", storeId: "env-store" };

describe("userContextFrom", () => {
  it("reads the namespaced keys a client is expected to send", () => {
    const user = userContextFrom(
      { [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "s", [REQUEST_ID_KEY]: "r" },
      undefined,
      null
    );
    expect(user).toEqual({ accessToken: "t", storeId: "s", requestId: "r" });
  });

  it("accepts the bare key names a human types by hand", () => {
    expect(userContextFrom({ accessToken: "t", storeId: "s" }, undefined, null)).toEqual({
      accessToken: "t",
      storeId: "s",
    });
  });

  it("prefers the namespaced key when both spellings are present", () => {
    const user = userContextFrom(
      { [ACCESS_TOKEN_KEY]: "namespaced", accessToken: "bare", [STORE_ID_KEY]: "s" },
      undefined,
      null
    );
    expect(user.accessToken).toBe("namespaced");
  });

  it("omits requestId entirely when the call carries none", () => {
    expect(userContextFrom({ [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "s" }, undefined, null)).not.toHaveProperty(
      "requestId"
    );
  });

  it("accepts a store id sent as a JSON number, as the MCP Inspector sends it", () => {
    // `--tool-metadata storeId=1234` JSON-parses to a number. Refusing it
    // would report a well-formed identity as "no credentials".
    expect(userContextFrom({ [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: 1234 }, undefined, null)).toEqual({
      accessToken: "t",
      storeId: "1234",
    });
  });

  it("lets the call's own credentials win over the env fallback", () => {
    const user = userContextFrom({ [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "s" }, undefined, envFallback);
    expect(user).toEqual({ accessToken: "t", storeId: "s" });
  });

  it("uses the env fallback only when the call carries nothing", () => {
    expect(userContextFrom(undefined, undefined, envFallback)).toEqual(envFallback);
    expect(userContextFrom({}, undefined, envFallback)).toEqual(envFallback);
  });

  it("throws MissingCredentialsError when neither source has credentials", () => {
    expect(() => userContextFrom(undefined, undefined, null)).toThrow(MissingCredentialsError);
  });

  it.each([
    ["only a token", { [ACCESS_TOKEN_KEY]: "t" }],
    ["only a store id", { [STORE_ID_KEY]: "s" }],
    ["a blank token", { [ACCESS_TOKEN_KEY]: "   ", [STORE_ID_KEY]: "s" }],
    ["a blank store id", { [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "" }],
    ["a non-scalar token", { [ACCESS_TOKEN_KEY]: { token: "t" }, [STORE_ID_KEY]: "s" }],
    ["a boolean store id", { [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: true }],
    ["a null store id", { [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: null }],
  ])("refuses a half-built identity: %s", (_label, meta) => {
    // A partial credential must fail closed rather than silently fall through
    // to the env fallback and act as the wrong user.
    expect(() => userContextFrom(meta, undefined, envFallback)).toThrow(MissingCredentialsError);
  });

  it("names both required _meta keys in the error, so the caller can fix the call", () => {
    expect(() => userContextFrom(undefined, undefined, null)).toThrow(ACCESS_TOKEN_KEY);
    expect(() => userContextFrom(undefined, undefined, null)).toThrow(STORE_ID_KEY);
  });
});

describe("userContextFrom, renewal credentials", () => {
  it("reads the refresh token and expiry a client sends alongside the access token", () => {
    expect(
      userContextFrom(
        {
          [ACCESS_TOKEN_KEY]: "t",
          [STORE_ID_KEY]: "s",
          [REFRESH_TOKEN_KEY]: "r",
          [EXPIRES_AT_KEY]: 1_790_001_288_734,
        },
        undefined,
        null
      )
    ).toEqual({ accessToken: "t", storeId: "s", refreshToken: "r", expiresAt: 1_790_001_288_734 });
  });

  it("accepts the bare key names too", () => {
    const user = userContextFrom(
      { accessToken: "t", storeId: "s", refreshToken: "r", expiresAt: "1790001288734" },
      undefined,
      null
    );
    expect(user.refreshToken).toBe("r");
    expect(user.expiresAt).toBe(1_790_001_288_734);
  });

  it("normalizes an expiry sent in seconds to milliseconds", () => {
    // Read as milliseconds, a seconds value is always long past, so every
    // single call would renew — slow, and silently so.
    const user = userContextFrom(
      { accessToken: "t", storeId: "s", refreshToken: "r", expiresAt: 1_790_001_288 },
      undefined,
      null
    );
    expect(user.expiresAt).toBe(1_790_001_288_000);
  });

  it("stays exactly as it was when the call sends no renewal credentials", () => {
    const user = userContextFrom({ accessToken: "t", storeId: "s" }, undefined, null);
    expect(user).not.toHaveProperty("refreshToken");
    expect(user).not.toHaveProperty("expiresAt");
  });

  it("keeps a refresh token without an expiry, for renewal on rejection alone", () => {
    const user = userContextFrom({ accessToken: "t", storeId: "s", refreshToken: "r" }, undefined, null);
    expect(user.refreshToken).toBe("r");
    expect(user).not.toHaveProperty("expiresAt");
  });

  it("ignores an expiry with no refresh token, since nothing could act on it", () => {
    const user = userContextFrom(
      { accessToken: "t", storeId: "s", expiresAt: 1_790_001_288_734 },
      undefined,
      null
    );
    expect(user).not.toHaveProperty("expiresAt");
  });

  it("takes renewal credentials from the same source as the access token, never mixed", () => {
    // The call asserts its own identity, so the env's refresh token belongs to
    // a different session and must not be used to renew this one.
    const user = userContextFrom({ accessToken: "t", storeId: "s" }, undefined, {
      ...envFallback,
      refreshToken: "env-refresh",
    });
    expect(user).not.toHaveProperty("refreshToken");
  });

  it("uses the env refresh token when the env also supplied the access token", () => {
    const user = userContextFrom(undefined, undefined, { ...envFallback, refreshToken: "env-refresh" });
    expect(user.refreshToken).toBe("env-refresh");
  });

  it("reads renewal credentials from the HTTP request that carried the call", () => {
    const user = userContextFrom(undefined, {
      accessToken: "t",
      storeId: "s",
      refreshToken: "r",
      expiresAt: 1_790_001_288_734,
    }, null);
    expect(user.refreshToken).toBe("r");
    expect(user.expiresAt).toBe(1_790_001_288_734);
  });

  it("never renders the refresh token as a header", () => {
    // It authenticates only the renewal endpoint's body. On a Hermes request
    // it is a live session secret with nothing to do there.
    expect(
      headersFor({ accessToken: "t", storeId: "s", refreshToken: "r", expiresAt: 1 })
    ).toEqual({ Authorization: "Bearer t", "X-Store-Id": "s", Accept: "application/json" });
  });
});

describe("headersFor", () => {
  it("renders exactly the headers Hermes authenticates on", () => {
    expect(headersFor({ accessToken: "t", storeId: "s" })).toEqual({
      Authorization: "Bearer t",
      "X-Store-Id": "s",
      Accept: "application/json",
    });
  });

  it("adds X-Request-ID only when the caller supplied a request id", () => {
    expect(headersFor({ accessToken: "t", storeId: "s", requestId: "r" })["X-Request-ID"]).toBe("r");
    expect(headersFor({ accessToken: "t", storeId: "s" })).not.toHaveProperty("X-Request-ID");
  });
});
