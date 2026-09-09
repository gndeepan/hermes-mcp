import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createLogger } from "../src/logging.js";
import { loadConfig } from "../src/config.js";
import { ENDPOINTS } from "../src/registry/endpoints.js";
import { TokenManager } from "../src/auth/tokenManager.js";
import type { StoredCredentials, TokenStore } from "../src/auth/tokenStore.js";

const noopStore: TokenStore = { read: () => null, write: () => {} };

const connect = async (tokenManager: TokenManager, name: string): Promise<Client> => {
  const config = loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" });
  const server = createServer(config, createLogger(config, () => {}), tokenManager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const stubDocsOnlyFetch = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ paths: {} }), { status: 200 }))
  );
};

let client: Client;

beforeAll(async () => {
  stubDocsOnlyFetch();
  client = await connect(
    new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, null),
    "integration-test"
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools/list", () => {
  it("advertises every allowlisted tool plus hermes_refresh_openapi, each with a description and schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...ENDPOINTS.map((e) => e.toolName), "hermes_refresh_openapi"].sort()
    );
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(5);
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });
});

describe("credentials", () => {
  it("rejects a Hermes-backed tool call with MISSING_CREDENTIALS when nothing is loaded", async () => {
    const result = await client.callTool({ name: "hermes_get_active_theme", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("MISSING_CREDENTIALS");
  });
});

describe("an end-to-end call through the real TokenManager and HermesClient", () => {
  it("calls hermes_get_active_theme and unwraps the {data} envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        String(url).endsWith("/v3/api-docs")
          ? new Response(JSON.stringify({ paths: {} }), { status: 200 })
          : new Response(JSON.stringify({ data: { id: "theme-1" } }), { status: 200 })
      )
    );
    const credentials: StoredCredentials = {
      accessToken: "test-token",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      storeId: "store-1",
    };
    const authed = await connect(
      new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, credentials),
      "authed-test-client"
    );

    const result = await authed.callTool({ name: "hermes_get_active_theme", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ id: "theme-1" });
  });
});

describe("stdout discipline", () => {
  /**
   * stdout is the MCP protocol transport, so anything written there corrupts
   * the stream for every client. On Node all of these console methods go to
   * stdout, not just `console.log`. Comments are deliberately *not* stripped:
   * a `console.log` inside a comment is a false positive a human clears in
   * seconds, whereas a false negative silently breaks the protocol.
   */
  const STDOUT_WRITERS =
    /console\.(log|info|debug|dir|table|group|groupEnd|groupCollapsed|count|countReset|timeLog|profile)\b|process\.stdout/;

  it("has no stdout-writing call anywhere under src/", () => {
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("src", f));

    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((f) => STDOUT_WRITERS.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it.each([
    "console.log('x')",
    "console.info('x')",
    "console.debug('x')",
    "console.dir(x)",
    "console.table(x)",
    "console.group('x')",
    "console.count('x')",
    "process.stdout.write('x')",
  ])("flags %s", (source) => {
    expect(STDOUT_WRITERS.test(source)).toBe(true);
  });

  it("leaves stderr-writing calls alone", () => {
    expect(STDOUT_WRITERS.test("console.error('x')")).toBe(false);
    expect(STDOUT_WRITERS.test("console.warn('x')")).toBe(false);
    expect(STDOUT_WRITERS.test("process.stderr.write('x')")).toBe(false);
  });
});
