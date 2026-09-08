import { describe, expect, it } from "vitest";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";

describe("loadSnapshotDoc", () => {
  it("loads the checked-in OpenAPI snapshot", () => {
    const doc = loadSnapshotDoc();
    expect(typeof doc.paths).toBe("object");
    expect(doc.paths["/api/v1/themes/active"]).toBeDefined();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(200);
  });
});
