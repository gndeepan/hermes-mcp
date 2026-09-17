import { describe, expect, it } from "vitest";
import { MissingCredentialsError } from "../src/errors.js";
import {
  ACCESS_TOKEN_KEY,
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
      null
    );
    expect(user).toEqual({ accessToken: "t", storeId: "s", requestId: "r" });
  });

  it("accepts the bare key names a human types by hand", () => {
    expect(userContextFrom({ accessToken: "t", storeId: "s" }, null)).toEqual({
      accessToken: "t",
      storeId: "s",
    });
  });

  it("prefers the namespaced key when both spellings are present", () => {
    const user = userContextFrom(
      { [ACCESS_TOKEN_KEY]: "namespaced", accessToken: "bare", [STORE_ID_KEY]: "s" },
      null
    );
    expect(user.accessToken).toBe("namespaced");
  });

  it("omits requestId entirely when the call carries none", () => {
    expect(userContextFrom({ [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "s" }, null)).not.toHaveProperty(
      "requestId"
    );
  });

  it("accepts a store id sent as a JSON number, as the MCP Inspector sends it", () => {
    // `--tool-metadata storeId=1234` JSON-parses to a number. Refusing it
    // would report a well-formed identity as "no credentials".
    expect(userContextFrom({ [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: 1234 }, null)).toEqual({
      accessToken: "t",
      storeId: "1234",
    });
  });

  it("lets the call's own credentials win over the env fallback", () => {
    const user = userContextFrom({ [ACCESS_TOKEN_KEY]: "t", [STORE_ID_KEY]: "s" }, envFallback);
    expect(user).toEqual({ accessToken: "t", storeId: "s" });
  });

  it("uses the env fallback only when the call carries nothing", () => {
    expect(userContextFrom(undefined, envFallback)).toEqual(envFallback);
    expect(userContextFrom({}, envFallback)).toEqual(envFallback);
  });

  it("throws MissingCredentialsError when neither source has credentials", () => {
    expect(() => userContextFrom(undefined, null)).toThrow(MissingCredentialsError);
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
    expect(() => userContextFrom(meta, envFallback)).toThrow(MissingCredentialsError);
  });

  it("names both required _meta keys in the error, so the caller can fix the call", () => {
    expect(() => userContextFrom(undefined, null)).toThrow(ACCESS_TOKEN_KEY);
    expect(() => userContextFrom(undefined, null)).toThrow(STORE_ID_KEY);
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
