import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const config = loadConfig({});
    expect(config.logLevel).toBe("info");
    expect(config.hermesBaseUrl).toBe("https://hermes-atlas.vjr-dev.com");
    expect(config.openApiDocsUrl).toBe("https://hermes-atlas.vjr-dev.com/v3/api-docs");
    expect(config.credentials).toBeNull();
  });

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ HERMES_MCP_LOG_LEVEL: "verbose" })).toThrow(
      /HERMES_MCP_LOG_LEVEL/
    );
  });

  it("ignores a refresh interval that is no longer a setting", () => {
    // The timer is gone; a value left behind in someone's .env must not throw.
    expect(() => loadConfig({ HERMES_OPENAPI_REFRESH_INTERVAL_S: "0" })).not.toThrow();
  });

  it("requires access token and store id together", () => {
    expect(() => loadConfig({ HERMES_ACCESS_TOKEN: "t" })).toThrow(/together/);
    expect(() => loadConfig({ HERMES_STORE_ID: "s" })).toThrow(/together/);
  });

  it("builds credentials when both are set", () => {
    const config = loadConfig({ HERMES_ACCESS_TOKEN: "t", HERMES_STORE_ID: "s" });
    expect(config.credentials).toEqual({ accessToken: "t", storeId: "s" });
  });

  it("carries an optional refresh token, so a long local run survives an expiry", () => {
    const config = loadConfig({
      HERMES_ACCESS_TOKEN: "t",
      HERMES_STORE_ID: "s",
      HERMES_REFRESH_TOKEN: "r",
    });
    expect(config.credentials).toEqual({ accessToken: "t", storeId: "s", refreshToken: "r" });
  });

  it("refuses a refresh token with no session for it to renew", () => {
    expect(() => loadConfig({ HERMES_REFRESH_TOKEN: "r" })).toThrow(/HERMES_REFRESH_TOKEN/);
  });
});

/**
 * The environment fallback is opt-in, and the default is the safety property.
 *
 * stdio used to mean one process per merchant, so acting as the configured
 * identity when a call carried no `_meta` was harmless. The ai-agent now runs
 * one child and serves everyone through it. In a shared process that fallback
 * turns a call that lost its credentials into a read as whatever merchant
 * happens to be in the environment — which succeeds, returns real data, and
 * belongs to the wrong person.
 */
describe("the single-user fallback", () => {
  it("is off unless asked for, even when credentials are configured", () => {
    const config = loadConfig({
      HERMES_ACCESS_TOKEN: "tok",
      HERMES_STORE_ID: "str_a",
    } as NodeJS.ProcessEnv);

    expect(config.credentials).toEqual({ accessToken: "tok", storeId: "str_a" });
    expect(config.singleUser).toBe(false);
  });

  it("is on when HERMES_SINGLE_USER is exactly 1", () => {
    const config = loadConfig({
      HERMES_ACCESS_TOKEN: "tok",
      HERMES_STORE_ID: "str_a",
      HERMES_SINGLE_USER: "1",
    } as NodeJS.ProcessEnv);

    expect(config.singleUser).toBe(true);
  });

  it("is not turned on by a truthy-looking value", () => {
    // "true", "yes" and "0" are all things someone writes meaning something.
    // Only the documented value counts, because the failure mode of guessing
    // wrong here is cross-tenant.
    for (const value of ["true", "yes", "0", "", "TRUE"]) {
      expect(loadConfig({ HERMES_SINGLE_USER: value } as NodeJS.ProcessEnv).singleUser).toBe(false);
    }
  });
});
