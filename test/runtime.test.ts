import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/server.js";
import { primeRegistry } from "../src/openapiSync.js";
import { createLogger } from "../src/logging.js";
import { loadConfig } from "../src/config.js";

const silent = createLogger(loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" }), () => {});

describe("ServerRuntime.operations", () => {
  it("exposes the operation index, built from the bundled snapshot", () => {
    const runtime = createRuntime(loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" }), silent);
    expect(runtime.operations.size).toBeGreaterThan(300);
    expect(runtime.operations.get("get", "/api/v1/themes/active")).toBeDefined();
  });

  it("replaces the index when a fetched document arrives", async () => {
    const runtime = createRuntime(loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" }), silent);
    const before = runtime.operations.size;

    // A document with exactly one operation, none of which the allowlist needs.
    // The index must follow the fetch, not stay on the snapshot.
    const tiny = { paths: { "/api/v1/only": { get: { summary: "Only" } } } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(tiny), { status: 200 })));

    await primeRegistry(runtime, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent);

    expect(runtime.operations.size).toBe(1);
    expect(runtime.operations.size).not.toBe(before);
    expect(runtime.operations.get("get", "/api/v1/only")).toBeDefined();
    expect(runtime.doc.paths["/api/v1/only"]).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("leaves the index alone when the fetch fails", async () => {
    const runtime = createRuntime(loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" }), silent);
    const before = runtime.operations.size;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    await primeRegistry(runtime, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent);

    expect(runtime.operations.size).toBe(before);
    vi.unstubAllGlobals();
  });
});
