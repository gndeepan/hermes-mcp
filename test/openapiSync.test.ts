import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenApiDoc, startOpenApiRefreshLoop } from "../src/openapiSync.js";
import { SchemaRegistry } from "../src/registry/schemaRegistry.js";
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

describe("startOpenApiRefreshLoop", () => {
  it("refreshes immediately without waiting for the first interval tick", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(loadSnapshotDoc()), { status: 200 }))
    );
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const logger = createLogger({ logLevel: "silent" });
    const infoSpy = vi.spyOn(logger, "info");

    const stop = startOpenApiRefreshLoop(
      registry,
      { openApiDocsUrl: "https://hermes.test/v3/api-docs", openApiFetchTimeoutMs: 1000, openApiRefreshIntervalS: 900 },
      logger
    );
    await vi.waitFor(() => expect(infoSpy).toHaveBeenCalledWith("openapi schema refresh ok"));
    stop();
  });

  it("invokes onRefreshed after a successful refresh so the new schemas get re-advertised", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(loadSnapshotDoc()), { status: 200 }))
    );
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const onRefreshed = vi.fn();

    const stop = startOpenApiRefreshLoop(
      registry,
      { openApiDocsUrl: "https://hermes.test/v3/api-docs", openApiFetchTimeoutMs: 1000, openApiRefreshIntervalS: 900 },
      createLogger({ logLevel: "silent" }),
      onRefreshed
    );
    await vi.waitFor(() => expect(onRefreshed).toHaveBeenCalledTimes(1));
    stop();
  });

  it("does not invoke onRefreshed when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const logger = createLogger({ logLevel: "silent" });
    const warnSpy = vi.spyOn(logger, "warn");
    const onRefreshed = vi.fn();

    const stop = startOpenApiRefreshLoop(
      registry,
      { openApiDocsUrl: "https://hermes.test/v3/api-docs", openApiFetchTimeoutMs: 1000, openApiRefreshIntervalS: 900 },
      logger,
      onRefreshed
    );
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(onRefreshed).not.toHaveBeenCalled();
    stop();
  });

  it("logs a warning and keeps going when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const logger = createLogger({ logLevel: "silent" });
    const warnSpy = vi.spyOn(logger, "warn");

    const stop = startOpenApiRefreshLoop(
      registry,
      { openApiDocsUrl: "https://hermes.test/v3/api-docs", openApiFetchTimeoutMs: 1000, openApiRefreshIntervalS: 900 },
      logger
    );
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    stop();
  });
});
