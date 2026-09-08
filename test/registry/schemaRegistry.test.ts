import { describe, expect, it, vi } from "vitest";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { ENDPOINTS } from "../../src/registry/endpoints.js";
import { createLogger } from "../../src/logging.js";
import { MissingOperationError } from "../../src/errors.js";

describe("SchemaRegistry", () => {
  it("compiles every allowlisted endpoint against the checked-in snapshot", () => {
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    for (const entry of ENDPOINTS) {
      expect(registry.get(entry.toolName).toolName).toBe(entry.toolName);
    }
    expect(registry.list()).toHaveLength(ENDPOINTS.length);
  });

  it("keeps the last-known-good schema for a tool missing from a refreshed doc, and logs it", () => {
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
    const before = registry.get("hermes_get_widget");
    const logger = createLogger({ logLevel: "silent" });
    const errorSpy = vi.spyOn(logger, "error");

    registry.refresh({ paths: {} }, logger);

    expect(registry.get("hermes_get_widget")).toBe(before);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("updates a tool's schema when the refreshed doc changes it", () => {
    const doc = loadSnapshotDoc();
    const registry = SchemaRegistry.fromDocument(doc);
    const logger = createLogger({ logLevel: "silent" });

    const patched = structuredClone(doc);
    patched.paths["/api/v1/widgets/{id}"].get!.parameters = [];

    registry.refresh(patched, logger);
    expect(registry.get("hermes_get_widget").paramLocations).toEqual({});
  });

  it("throws MissingOperationError from fromDocument when an allowlisted operation can't be compiled", () => {
    const doc = loadSnapshotDoc();
    const patched = structuredClone(doc);
    delete patched.paths["/api/v1/widgets/{id}"];

    expect(() => SchemaRegistry.fromDocument(patched)).toThrow(MissingOperationError);
  });
});
