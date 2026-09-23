import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createLogger } from "../src/logging.js";
import { loadConfig } from "../src/config.js";
import { ENDPOINTS } from "../src/registry/endpoints.js";
import { ACCESS_TOKEN_KEY, REQUEST_ID_KEY, STORE_ID_KEY } from "../src/userContext.js";

const connect = async (name: string): Promise<Client> => {
  const config = loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" });
  const server = createServer(config, createLogger(config, () => {}));
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
  client = await connect("integration-test");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools/list", () => {
  it("advertises every allowlisted tool plus hermes_refresh_openapi, each with a description and schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        ...ENDPOINTS.map((e) => e.toolName),
        "hermes_refresh_openapi",
        "hermes_find_api",
        "hermes_call_api",
      ].sort()
    );
    for (const tool of tools) {
      // A description is the only thing a model sees before picking a tool, so
      // a stub like "Get one page by id." is treated as a missing description.
      expect(tool.description?.length ?? 0).toBeGreaterThan(120);
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });
});

describe("credentials", () => {
  it("rejects a Hermes-backed tool call with MISSING_CREDENTIALS when the call carries none", async () => {
    const result = await client.callTool({ name: "hermes_get_active_theme", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("MISSING_CREDENTIALS");
  });

  it("names the _meta keys to send, so the caller can fix the call from the error alone", async () => {
    const result = await client.callTool({ name: "hermes_get_active_theme", arguments: {} });
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain(ACCESS_TOKEN_KEY);
    expect(text).toContain(STORE_ID_KEY);
  });
});

describe("an end-to-end call carrying the caller's credentials in _meta", () => {
  it("turns _meta into Hermes headers and unwraps the {data} envelope", async () => {
    const sent: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        if (String(url).endsWith("/v3/api-docs")) {
          return new Response(JSON.stringify({ paths: {} }), { status: 200 });
        }
        sent.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ data: { id: "theme-1" } }), { status: 200 });
      })
    );
    const authed = await connect("authed-test-client");

    const result = await authed.callTool({
      _meta: {
        [ACCESS_TOKEN_KEY]: "test-token",
        [STORE_ID_KEY]: "store-1",
        [REQUEST_ID_KEY]: "trace-1",
      },
      name: "hermes_get_active_theme",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ id: "theme-1" });
    expect(sent[0].Authorization).toBe("Bearer test-token");
    expect(sent[0]["X-Store-Id"]).toBe("store-1");
    expect(sent[0]["X-Request-ID"]).toBe("trace-1");
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

describe("the API gateway", () => {
  it("advertises both gateway tools with usable descriptions", async () => {
    const client = await connect("gateway-descriptions");
    const { tools } = await client.listTools();

    const find = tools.find((t) => t.name === "hermes_find_api");
    const call = tools.find((t) => t.name === "hermes_call_api");
    expect(find).toBeDefined();
    expect(call).toBeDefined();
    expect(find!.description!.length).toBeGreaterThanOrEqual(120);
    expect(call!.description!.length).toBeGreaterThanOrEqual(120);
    // The destructive warning is the one line that must survive any edit: it is
    // the only thing telling a client to ask a human before a delete.
    expect(call!.description).toMatch(/MODIFY AND DELETE/);
  });

  it("lists the curated tools before the gateway", async () => {
    const client = await connect("gateway-order");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.indexOf("hermes_get_active_theme")).toBeLessThan(names.indexOf("hermes_call_api"));
    expect(names.indexOf("hermes_update_widget")).toBeLessThan(names.indexOf("hermes_find_api"));
  });

  it("searches without credentials, because searching reaches nothing", async () => {
    const client = await connect("gateway-search");
    const result = await client.callTool({
      name: "hermes_find_api",
      arguments: { query: "user" },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0].text) as {
      candidates: unknown[];
    };
    expect(payload.candidates.length).toBeGreaterThan(0);
  });

  it("refuses a gateway call with no credentials before reaching the network", async () => {
    const client = await connect("gateway-credentials");
    const result = await client.callTool({
      name: "hermes_call_api",
      arguments: { method: "get", path: "/api/v1/themes/active" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("[MISSING_CREDENTIALS]");
  });
});
