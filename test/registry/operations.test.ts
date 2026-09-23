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

import { substitutePath, coerceQuery, resolveRefOnce } from "../../src/registry/operations.js";
import { InvalidPathParameterError } from "../../src/errors.js";

describe("substitutePath", () => {
  it("fills every placeholder", () => {
    expect(substitutePath("/api/v1/stores/{storeId}/users/{userId}", { storeId: "str_1", userId: "usr_2" }))
      .toBe("/api/v1/stores/str_1/users/usr_2");
  });

  it("refuses a missing parameter rather than sending a literal placeholder", () => {
    expect(() => substitutePath("/api/v1/users/{id}", {})).toThrow(InvalidPathParameterError);
  });

  it("refuses an empty parameter", () => {
    expect(() => substitutePath("/api/v1/users/{id}", { id: "  " })).toThrow(InvalidPathParameterError);
  });

  it("encodes a value that would otherwise escape the path", () => {
    // Review Focus #3. Raw substitution here would rewrite the URL entirely.
    expect(substitutePath("/api/v1/users/{id}", { id: "../../admin" }))
      .toBe("/api/v1/users/..%2F..%2Fadmin");
    expect(substitutePath("/api/v1/users/{id}", { id: "a/b?x=1" }))
      .toBe("/api/v1/users/a%2Fb%3Fx%3D1");
  });

  it("accepts a number, because an id sent as JSON often is one", () => {
    expect(substitutePath("/api/v1/x/{id}", { id: 50090 })).toBe("/api/v1/x/50090");
  });
});

describe("coerceQuery", () => {
  it("stringifies scalars", () => {
    expect(coerceQuery({ page: 1, size: 20, active: true, name: "x" }))
      .toEqual({ page: "1", size: "20", active: "true", name: "x" });
  });

  it("joins an array with commas rather than producing [object Object]", () => {
    // Review Focus #5.
    expect(coerceQuery({ tags: ["a", "b"] })).toEqual({ tags: "a,b" });
  });

  it("drops null and undefined instead of sending the word 'null'", () => {
    expect(coerceQuery({ a: null, b: undefined, c: "keep" })).toEqual({ c: "keep" });
  });

  it("drops an object, which has no defensible query spelling", () => {
    expect(coerceQuery({ nested: { a: 1 } })).toEqual({});
  });
});

describe("resolveRefOnce", () => {
  const doc = {
    paths: {},
    components: { schemas: { User: { type: "object", properties: { id: { $ref: "#/components/schemas/Id" } } } } },
  } as never;

  it("resolves one level", () => {
    expect(resolveRefOnce(doc, { $ref: "#/components/schemas/User" }))
      .toEqual({ type: "object", properties: { id: { $ref: "#/components/schemas/Id" } } });
  });

  it("leaves a deeper ref as a string rather than recursing", () => {
    const out = resolveRefOnce(doc, { $ref: "#/components/schemas/User" }) as Record<string, never>;
    expect((out.properties as Record<string, unknown>).id).toEqual({ $ref: "#/components/schemas/Id" });
  });

  it("returns the input unchanged when there is nothing to resolve", () => {
    expect(resolveRefOnce(doc, { type: "string" })).toEqual({ type: "string" });
    expect(resolveRefOnce(doc, undefined)).toBeUndefined();
  });

  it("returns the ref unchanged when the target is missing", () => {
    expect(resolveRefOnce(doc, { $ref: "#/components/schemas/Absent" }))
      .toEqual({ $ref: "#/components/schemas/Absent" });
  });
});
