import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const config = loadConfig({});
    expect(config.logLevel).toBe("info");
    expect(config.hermesBaseUrl).toBe("https://hermes-atlas.vjr-dev.com");
    expect(config.openApiDocsUrl).toBe("https://hermes-atlas.vajro.com/v3/api-docs");
    expect(config.openApiRefreshIntervalS).toBe(900);
    expect(config.credentials).toBeNull();
  });

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ HERMES_MCP_LOG_LEVEL: "verbose" })).toThrow(
      /HERMES_MCP_LOG_LEVEL/
    );
  });

  it("rejects a non-positive refresh interval", () => {
    expect(() => loadConfig({ HERMES_OPENAPI_REFRESH_INTERVAL_S: "0" })).toThrow(
      /HERMES_OPENAPI_REFRESH_INTERVAL_S/
    );
  });

  it("requires access token and store id together", () => {
    expect(() => loadConfig({ HERMES_ACCESS_TOKEN: "t" })).toThrow(/together/);
    expect(() => loadConfig({ HERMES_STORE_ID: "s" })).toThrow(/together/);
  });

  it("builds credentials when both are set", () => {
    const config = loadConfig({ HERMES_ACCESS_TOKEN: "t", HERMES_STORE_ID: "s" });
    expect(config.credentials).toEqual({ accessToken: "t", storeId: "s" });
  });
});
