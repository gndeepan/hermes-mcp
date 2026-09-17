import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging.js";
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
  InvalidPathParameterError,
  MissingCredentialsError,
  MissingOperationError,
  errorMessage,
  toToolResult,
} from "../src/errors.js";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies a non-Error", () => {
    expect(errorMessage("boom")).toBe("boom");
  });
});

describe("toToolResult", () => {
  const cases: [Error, string][] = [
    [new HermesUnauthenticatedError("/x"), "UNAUTHENTICATED"],
    [new HermesForbiddenError("/x"), "FORBIDDEN"],
    [new HermesNotFoundError("/x"), "NOT_FOUND"],
    [new HermesRejectedError("/x", 422, "bad body"), "REJECTED"],
    [new HermesUnavailableError("/x", new Error("down")), "UNAVAILABLE"],
    [new MissingCredentialsError(), "MISSING_CREDENTIALS"],
    [new InvalidPathParameterError("/api/v1/stores/{storeId}", 'bad "storeId"'), "INVALID_PATH_PARAM"],
  ];

  it.each(cases)("maps %s to a visible, coded tool result", (error, code) => {
    const logger = createLogger({ logLevel: "silent" });
    const result = toToolResult(error, logger, "hermes_get_widget");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`[${code}]`);
  });

  it("hides an unrecognised error behind a correlation id instead of its raw message", () => {
    const logger = createLogger({ logLevel: "silent" });
    const errorSpy = vi.spyOn(logger, "error");
    const result = toToolResult(new TypeError("unexpected internal bug"), logger, "hermes_get_widget");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("unexpected internal bug");
    expect(result.content[0].text).toMatch(/reference/i);
    expect(errorSpy).toHaveBeenCalledWith(
      "tool call failed unexpectedly",
      expect.objectContaining({ tool: "hermes_get_widget" })
    );
  });

  it("MissingCredentialsError names both the _meta keys and the env var fallback", () => {
    const err = new MissingCredentialsError();
    expect(err.message).toContain("_meta");
    expect(err.message).toContain("com.superfans.hermes/accessToken");
    expect(err.message).toContain("com.superfans.hermes/storeId");
    expect(err.message).toContain("HERMES_ACCESS_TOKEN");
  });

  it("MissingOperationError names the tool, method and path", () => {
    const err = new MissingOperationError("hermes_get_widget", "get", "/api/v1/widgets/{id}");
    expect(err.message).toContain("hermes_get_widget");
    expect(err.message).toContain("GET");
    expect(err.message).toContain("/api/v1/widgets/{id}");
  });
});
