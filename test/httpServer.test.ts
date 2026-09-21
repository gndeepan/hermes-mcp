import { describe, expect, it } from "vitest";
import { credentialsFrom } from "../src/httpServer.js";

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

describe("credentialsFrom", () => {
  it("reads the bearer token and the store header a standard MCP client sends", () => {
    expect(
      credentialsFrom(headers({ authorization: "Bearer tok", "x-store-id": "s1" }))
    ).toEqual({ accessToken: "tok", storeId: "s1" });
  });

  it("carries the request id through so one trace runs caller -> MCP -> Hermes", () => {
    const creds = credentialsFrom(
      headers({ authorization: "Bearer tok", "x-store-id": "s1", "x-request-id": "req-1" })
    );
    expect(creds?.requestId).toBe("req-1");
  });

  it("returns undefined when the request asserts no identity at all", () => {
    // Not an empty identity: nothing was asserted, so the next source down
    // (under stdio, `_meta`) is still allowed to speak.
    expect(credentialsFrom(headers({}))).toBeUndefined();
  });

  it("returns a half-filled identity rather than completing it, for userContextFrom to refuse", () => {
    expect(credentialsFrom(headers({ authorization: "Bearer tok" }))).toEqual({
      accessToken: "tok",
      storeId: "",
    });
  });

  it("reads the renewal headers when the caller grants a session renewal", () => {
    expect(
      credentialsFrom(
        headers({
          authorization: "Bearer tok",
          "x-store-id": "s1",
          "x-refresh-token": "r1",
          "x-token-expires-at": "1790001288734",
        })
      )
    ).toEqual({
      accessToken: "tok",
      storeId: "s1",
      refreshToken: "r1",
      expiresAt: 1_790_001_288_734,
    });
  });

  it("normalizes an expiry sent in seconds", () => {
    const creds = credentialsFrom(
      headers({
        authorization: "Bearer tok",
        "x-store-id": "s1",
        "x-refresh-token": "r1",
        "x-token-expires-at": "1790001288",
      })
    );
    expect(creds?.expiresAt).toBe(1_790_001_288_000);
  });

  it("keeps a refresh token with no expiry, for renewal on rejection alone", () => {
    const creds = credentialsFrom(
      headers({ authorization: "Bearer tok", "x-store-id": "s1", "x-refresh-token": "r1" })
    );
    expect(creds?.refreshToken).toBe("r1");
    expect(creds).not.toHaveProperty("expiresAt");
  });

  it("drops an expiry sent with no refresh token, since nothing could act on it", () => {
    const creds = credentialsFrom(
      headers({ authorization: "Bearer tok", "x-store-id": "s1", "x-token-expires-at": "1790001288734" })
    );
    expect(creds).not.toHaveProperty("expiresAt");
    expect(creds).not.toHaveProperty("refreshToken");
  });

  it("leaves renewal off when the request sends no renewal headers", () => {
    expect(
      credentialsFrom(headers({ authorization: "Bearer tok", "x-store-id": "s1" }))
    ).not.toHaveProperty("refreshToken");
  });

  it("ignores an unparseable expiry rather than renewing on every call", () => {
    // Read as a number, "soon" is NaN. Treating that as "long expired" would
    // renew on every single call, slowly and silently.
    const creds = credentialsFrom(
      headers({
        authorization: "Bearer tok",
        "x-store-id": "s1",
        "x-refresh-token": "r1",
        "x-token-expires-at": "soon",
      })
    );
    expect(creds).not.toHaveProperty("expiresAt");
    expect(creds?.refreshToken).toBe("r1");
  });
});
