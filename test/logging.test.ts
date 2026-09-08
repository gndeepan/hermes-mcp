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

  it("never writes to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write");
    const logger = createLogger({ logLevel: "debug" });
    logger.info("hello");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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

  it("writes silent level as nothing at all", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "silent" }, (line) => lines.push(line));
    logger.error("should not appear");
    expect(lines).toHaveLength(0);
  });
});
