import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenStore, normalizeExpiresAt } from "../../src/auth/tokenStore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hermes-mcp-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeExpiresAt", () => {
  it("multiplies a seconds-epoch value up to milliseconds", () => {
    expect(normalizeExpiresAt(1_800_000_000)).toBe(1_800_000_000_000);
  });

  it("leaves a milliseconds-epoch value unchanged", () => {
    expect(normalizeExpiresAt(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
});

describe("createTokenStore", () => {
  it("returns null when no file exists yet", () => {
    expect(createTokenStore(dir).read()).toBeNull();
  });

  it("round-trips written credentials, creating the directory if needed", () => {
    const store = createTokenStore(path.join(dir, "nested"));
    store.write({ accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000_000, storeId: "s1" });
    expect(store.read()).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_800_000_000_000,
      storeId: "s1",
    });
  });

  it("normalizes a seconds-epoch expiresAt on write", () => {
    const store = createTokenStore(dir);
    store.write({ accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000, storeId: "s1" });
    expect(store.read()?.expiresAt).toBe(1_800_000_000_000);
  });

  it("returns null for a corrupt file instead of throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "credentials.json"), "not json", "utf-8");
    expect(createTokenStore(dir).read()).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ accessToken: "a" }), "utf-8");
    expect(createTokenStore(dir).read()).toBeNull();
  });
});
