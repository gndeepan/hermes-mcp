import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging.js";

describe("createLogger", () => {
  it("writes JSON lines only at or above the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "warn" }, (line) => lines.push(line));

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).message).toBe("warn message");
    expect(JSON.parse(lines[1]).message).toBe("error message");
  });

  it("writes to stderr and never to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ logLevel: "debug" });

    logger.info("hello");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0][0])).toContain("hello");
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it("redacts a token-shaped field even if a caller passes one by mistake", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));
    logger.info("oops", { authorization: "Bearer secret", accessToken: "secret2", other: "fine" });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.authorization).toBe("[REDACTED]");
    expect(parsed.accessToken).toBe("[REDACTED]");
    expect(parsed.other).toBe("fine");
  });

  it("redacts a credential-shaped key nested inside another object", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));

    logger.debug("tool call start", {
      tool: "hermes_get_widget",
      query: { page: "1", accessToken: "secret", nested: { refreshToken: "deeper" } },
      items: [{ token: "in-an-array" }],
    });

    const parsed = JSON.parse(lines[0]) as Record<string, never>;
    expect(parsed.query).toEqual({
      page: "1",
      accessToken: "[REDACTED]",
      nested: { refreshToken: "[REDACTED]" },
    });
    expect(parsed.items).toEqual([{ token: "[REDACTED]" }]);
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("deeper");
    expect(lines[0]).not.toContain("in-an-array");
  });

  it("survives a cyclic meta object without recursing forever", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));
    const cyclic: Record<string, unknown> = { token: "secret" };
    cyclic.self = cyclic;

    logger.info("cycle", { cyclic });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("secret");
  });

  it("writes silent level as nothing at all", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "silent" }, (line) => lines.push(line));
    logger.error("should not appear");
    expect(lines).toHaveLength(0);
  });
});
