import { describe, expect, it } from "vitest";
import { OperationIndex } from "../../src/registry/operations.js";
import { searchOperations } from "../../src/registry/search.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";

const DOC = loadSnapshotDoc();
const INDEX = OperationIndex.fromDocument(DOC);

describe("searchOperations", () => {
  it("puts the user read first for 'get user info'", () => {
    // Hermes publishes no GET /api/v1/users/{id} — /users/{id} is PUT and
    // DELETE only — so the operation that answers this is /users/me.
    const { candidates } = searchOperations(INDEX, DOC, { query: "get user info" });
    expect(candidates[0]).toMatchObject({ method: "get", path: "/api/v1/users/me" });
  });

  it("does not let the HTTP verb in a query outrank the noun", () => {
    // "get" matched the summary "Get App Info" and floated an apps endpoint to
    // the top for a question about users. Verbs are a method hint, not content.
    const { candidates } = searchOperations(INDEX, DOC, { query: "get user info", limit: 3 });
    expect(candidates.map((c) => c.path)).not.toContain("/api/v1/apps/{appId}/details/app-info");
  });

  it("matches a singular query against a plural path segment", () => {
    const { candidates } = searchOperations(INDEX, DOC, { query: "user", limit: 5 });
    expect(candidates.some((c) => c.path.includes("/users"))).toBe(true);
  });

  it("filters by method", () => {
    const { candidates } = searchOperations(INDEX, DOC, { query: "user", method: "delete" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.method === "delete")).toBe(true);
  });

  it("honours the limit", () => {
    expect(searchOperations(INDEX, DOC, { query: "store", limit: 3 }).candidates).toHaveLength(3);
  });

  it("describes the path parameters of a returned operation", () => {
    // Ranking is asserted by its own tests; this one is about whether a
    // candidate carries enough detail to be called without guessing.
    const { candidates } = searchOperations(INDEX, DOC, { query: "store", limit: 25 });
    const info = candidates.find((c) => c.path === "/api/v1/stores/{id}/info");
    expect(info).toBeDefined();
    expect(info!.pathParams.map((p) => p.name)).toContain("id");
    expect(info!.pathParams.find((p) => p.name === "id")!.required).toBe(true);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchOperations(INDEX, DOC, { query: "zzzznotathing" }).candidates).toHaveLength(0);
  });

  it("always returns at least one candidate even when it alone exceeds the cap", () => {
    // Review Focus #4: a naive cap returns an empty list and tells the agent
    // the API does not exist, which is a worse answer than a large one.
    const { candidates, truncated } = searchOperations(INDEX, DOC, { query: "store info", maxBytes: 10 });
    expect(candidates).toHaveLength(1);
    expect(truncated).toBeGreaterThan(0);
  });

  it("drops candidates from the tail to stay under the cap", () => {
    const full = searchOperations(INDEX, DOC, { query: "store", limit: 25 });
    const capped = searchOperations(INDEX, DOC, { query: "store", limit: 25, maxBytes: 4000 });
    expect(capped.candidates.length).toBeLessThan(full.candidates.length);
    expect(capped.truncated).toBe(full.candidates.length - capped.candidates.length);
    expect(JSON.stringify(capped.candidates).length).toBeLessThanOrEqual(4000);
  });
});
