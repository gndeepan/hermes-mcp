import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenApiDoc, primeRegistry } from "../src/openapiSync.js";
import { SchemaRegistry } from "../src/registry/schemaRegistry.js";
import { OperationIndex } from "../src/registry/operations.js";
import { loadSnapshotDoc } from "../src/registry/snapshot.js";
import { createLogger } from "../src/logging.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenApiDoc", () => {
  it("returns the parsed document on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ paths: {} }), { status: 200 }))
    );
    const doc = await fetchOpenApiDoc("https://hermes.test/v3/api-docs", 1000);
    expect(doc).toEqual({ paths: {} });
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(fetchOpenApiDoc("https://hermes.test/v3/api-docs", 1000)).rejects.toThrow(/500/);
  });
});

describe("primeRegistry", () => {
  const silent = createLogger({ logLevel: "silent" });

  it("fetches once and does not schedule another fetch", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(loadSnapshotDoc()), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const target = { registry, operations: OperationIndex.fromDocument(loadSnapshotDoc()), doc: loadSnapshotDoc() };

    await primeRegistry(target, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The whole point of this task: no timer is left behind to fire later.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("keeps the snapshot and resolves when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const target = { registry, operations: OperationIndex.fromDocument(loadSnapshotDoc()), doc: loadSnapshotDoc() };

    // Must not reject: the server starts with or without the network.
    await expect(
      primeRegistry(target, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent)
    ).resolves.toBeUndefined();
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it("runs the re-advertise callback after a successful load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(loadSnapshotDoc()), { status: 200 })));
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const target = { registry, operations: OperationIndex.fromDocument(loadSnapshotDoc()), doc: loadSnapshotDoc() };
    const onRefreshed = vi.fn();

    await primeRegistry(target, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent, onRefreshed);
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  it("does not run the callback when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const target = { registry, operations: OperationIndex.fromDocument(loadSnapshotDoc()), doc: loadSnapshotDoc() };
    const onRefreshed = vi.fn();

    await primeRegistry(target, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent, onRefreshed);
    expect(onRefreshed).not.toHaveBeenCalled();
  });
});
