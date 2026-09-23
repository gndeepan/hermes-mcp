import { describe, expect, it } from "vitest";
import { OperationIndex, keyOf } from "../../src/registry/operations.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";

const DOC = {
  paths: {
    "/api/v1/users/{id}": {
      get: { summary: "Read user", tags: ["User"], parameters: [{ name: "id", in: "path", required: true }] },
      put: { summary: "Update user", tags: ["User"] },
    },
    "/api/v1/users": { get: { summary: "List users", tags: ["User"] } },
  },
} as never;

describe("OperationIndex", () => {
  it("indexes every method of every path", () => {
    const index = OperationIndex.fromDocument(DOC);
    expect(index.size).toBe(3);
    expect(index.all().map((o) => keyOf(o.method, o.path))).toContain("GET /api/v1/users/{id}");
  });

  it("looks up case-insensitively by method", () => {
    const index = OperationIndex.fromDocument(DOC);
    expect(index.get("get", "/api/v1/users/{id}")?.summary).toBe("Read user");
    expect(index.get("GET", "/api/v1/users/{id}")?.summary).toBe("Read user");
  });

  it("returns undefined for an operation that is not there", () => {
    const index = OperationIndex.fromDocument(DOC);
    expect(index.get("delete", "/api/v1/users/{id}")).toBeUndefined();
    expect(index.get("get", "/api/v1/nope")).toBeUndefined();
  });

  it("suggests the same path under a different verb", () => {
    const index = OperationIndex.fromDocument(DOC);
    // Right path, wrong verb: the most common mistake, and the one worth naming.
    expect(index.nearest("delete", "/api/v1/users/{id}")).toContain("GET /api/v1/users/{id}");
    expect(index.nearest("delete", "/api/v1/users/{id}")).toContain("PUT /api/v1/users/{id}");
  });

  it("ignores non-operation keys on a path item", () => {
    const withJunk = { paths: { "/x": { get: { summary: "X" }, parameters: [], servers: [] } } } as never;
    expect(OperationIndex.fromDocument(withJunk).size).toBe(1);
  });

  it("merges path-item parameters into every operation under it", () => {
    const shared = {
      paths: {
        "/a/{id}": {
          parameters: [{ name: "id", in: "path", required: true }],
          get: { summary: "G", parameters: [{ name: "q", in: "query" }] },
        },
      },
    } as never;
    const op = OperationIndex.fromDocument(shared).get("get", "/a/{id}")!;
    expect(op.parameters.map((p) => p.name)).toEqual(["id", "q"]);
  });

  it("indexes the real bundled snapshot without throwing", () => {
    const index = OperationIndex.fromDocument(loadSnapshotDoc());
    expect(index.size).toBeGreaterThan(300);
    expect(index.get("get", "/api/v1/themes/active")).toBeDefined();
  });
});
