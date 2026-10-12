import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokedAs } from "../src/entry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-entry-"));
  dirs.push(dir);
  const server = join(dir, "server.js");
  const http = join(dir, "httpServer.js");
  writeFileSync(server, "");
  writeFileSync(http, "");
  return { dir, server, http };
};

describe("invokedAs", () => {
  it("matches the file it was started as", () => {
    const { server, http } = fixture();
    expect(invokedAs("server.js", server)).toBe(true);
    expect(invokedAs("httpServer.js", http)).toBe(true);
  });

  it("follows the symlink npm and npx start a bin through", () => {
    // `node_modules/.bin/hermes-mcp -> ../@superfans/hermes-mcp/dist/server.js`:
    // the path ends in `hermes-mcp`, and only resolving it says what runs.
    const { dir, server } = fixture();
    const bin = join(dir, "hermes-mcp");
    symlinkSync(server, bin);
    expect(invokedAs("server.js", bin)).toBe(true);
  });

  it("does not mistake one entry for the other", () => {
    const { server, http } = fixture();
    expect(invokedAs("server.js", http)).toBe(false);
    expect(invokedAs("httpServer.js", server)).toBe(false);
  });

  it("is false when there is no script path, as under a test runner or a REPL", () => {
    expect(invokedAs("server.js", undefined)).toBe(false);
    expect(invokedAs("server.js", "/no/such/server-file.js")).toBe(false);
  });
});
