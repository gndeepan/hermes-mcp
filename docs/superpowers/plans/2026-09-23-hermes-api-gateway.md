# Hermes API Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the periodic OpenAPI refresh with a single startup fetch, and add two tools that let an agent find any Hermes operation in the OpenAPI document and invoke it.

**Architecture:** A new `OperationIndex` holds the raw OpenAPI document keyed by `METHOD /path` — the existing `SchemaRegistry` cannot serve this, because it discards the document and keeps only the twelve compiled allowlisted endpoints. `hermes_find_api` ranks operations in that index lexically against a query; `hermes_call_api` looks one up, substitutes path parameters and sends it through the existing `HermesClient`, inheriting credential resolution, token renewal and error mapping unchanged.

**Tech Stack:** TypeScript (ESM, NodeNext), `@modelcontextprotocol/server` v2, Zod v4, Vitest v3, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-23-hermes-api-gateway-design.md`

## Global Constraints

- Node `>=20`; the build is `node scripts/build.mjs` (esbuild), typecheck is `tsc --noEmit`.
- All imports use explicit `.js` extensions (NodeNext resolution), e.g. `import { x } from "./y.js"`.
- Tool descriptions must be at least **120 characters** — enforced by `test/integration.test.ts` and `scripts/inspect-smoke.mjs` (`MIN_DESCRIPTION_CHARS = 120`).
- `HttpMethod` is `"get" | "post" | "put" | "delete"`. The Hermes document contains **no** `patch` operations (verified: 141 get, 122 post, 59 put, 34 delete, 0 patch). Do not add `patch`.
- Credentials are never logged. `src/logging.ts` redacts token-shaped keys, but do not pass tokens into log calls regardless.
- Tests are `vitest`; run with `npx vitest run <path>`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## Review Focus

Five failure modes the spec implies but does not assign tests to. Each is pinned to a task below.

1. **`MissingOperationError` surfaces as an opaque internal fault.** It is defined at `src/errors.ts:125` but absent from `KNOWN_ERROR_CODES` (`src/errors.ts:139-149`), so `toToolResult` falls through to "The tool failed unexpectedly. Reference `<hex>`". An agent asking for a path that does not exist deserves `[UNKNOWN_OPERATION]` naming near matches. — **Task 6**
2. **Nested `storeId` bypasses the cross-tenant guard.** `assertActingOnOwnStore` (`src/tools/index.ts:157`) reads a flat `args.storeId`. The gateway's ids live in `pathParams.storeId` and `body.storeId`, so a call naming another merchant's store would be sent. — **Task 6**
3. **Path parameters can escape the path.** A `pathParams` value of `../../admin`, or one containing `/` or `?`, would rewrite the URL if substituted raw. Every value must be `encodeURIComponent`-ed and rejected if empty. — **Task 3**
4. **A single operation larger than the response cap returns nothing.** If the first candidate's hydrated schema alone exceeds 60 KB, a naive cap drops it and returns an empty list, telling the agent the API does not exist. At least one candidate must always come back, truncated if need be. — **Task 4**
5. **Non-string query and path values.** `HermesClient.request` takes `query: Record<string, string>`. An agent passing `{page: 1}` or `{tags: ["a","b"]}` must be coerced predictably, not stringified as `[object Object]`. — **Task 3**

---

## File Structure

| File | Responsibility |
|---|---|
| `src/registry/operations.ts` | **Create.** `OperationIndex`: builds a `METHOD /path` map from an `OpenApiDocument`, resolves `$ref` one level, substitutes path templates, coerces query values. |
| `src/registry/search.ts` | **Create.** Lexical ranking of indexed operations against a query string. Pure; no I/O. |
| `src/tools/gateway.ts` | **Create.** Registers `hermes_find_api` and `hermes_call_api`. |
| `src/openapiSync.ts` | **Modify.** Delete `startOpenApiRefreshLoop`'s timer; expose `primeRegistry` (one fetch). |
| `src/config.ts` | **Modify.** Delete `openApiRefreshIntervalS`. |
| `src/server.ts` | **Modify.** Hold `OperationIndex` on `ServerRuntime`; call `primeRegistry`. |
| `src/tools/index.ts` | **Modify.** Register gateway tools; lift the store guard; update `hermes_refresh_openapi` to refresh the index too. |
| `src/errors.ts` | **Modify.** Add `MissingOperationError` → `UNKNOWN_OPERATION` to `KNOWN_ERROR_CODES`. |

---

### Task 1: Remove the background refresh timer

**Files:**
- Modify: `src/openapiSync.ts:38-67`
- Modify: `src/config.ts:46-52`, `src/config.ts:74`
- Modify: `src/server.ts` (call site)
- Modify: `src/httpServer.ts` (call site)
- Modify: `.env`, `.env.example`, `README.md`
- Test: `test/openapiSync.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `primeRegistry(registry: SchemaRegistry, config: PrimeConfig, logger: Logger, onRefreshed?: () => void): Promise<void>` where `PrimeConfig = { openApiDocsUrl: string; openApiFetchTimeoutMs: number }`. `fetchOpenApiDoc` keeps its current signature.

- [ ] **Step 1: Write the failing test**

Replace the interval-based tests in `test/openapiSync.test.ts` with these:

```ts
import { describe, expect, it, vi } from "vitest";
import { primeRegistry } from "../src/openapiSync.js";
import { SchemaRegistry } from "../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../src/registry/snapshot.js";
import { createLogger } from "../src/logging.js";

const silent = createLogger({ logLevel: "silent" } as never);

describe("primeRegistry", () => {
  it("fetches once and does not schedule another fetch", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(loadSnapshotDoc())));
    vi.stubGlobal("fetch", fetchSpy);
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());

    await primeRegistry(registry, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The whole point of this task: no timer is left behind to fire later.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("keeps the snapshot and resolves when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());

    // Must not reject: the server starts with or without the network.
    await expect(
      primeRegistry(registry, { openApiDocsUrl: "https://x/spec", openApiFetchTimeoutMs: 100 }, silent)
    ).resolves.toBeUndefined();
    expect(registry.list().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/openapiSync.test.ts`
Expected: FAIL — `primeRegistry` is not exported from `src/openapiSync.ts`.

- [ ] **Step 3: Replace the loop with a single fetch**

In `src/openapiSync.ts`, delete `RefreshLoopConfig` and `startOpenApiRefreshLoop` entirely and add:

```ts
export interface PrimeConfig {
  openApiDocsUrl: string;
  openApiFetchTimeoutMs: number;
}

/**
 * Brings the registry up to the live specification, once, at startup.
 *
 * There used to be a timer here, re-fetching every fifteen minutes and
 * re-advertising whatever changed. It was removed deliberately: a tool schema
 * that changes underneath a session in progress makes a call that was valid
 * when the agent composed it invalid by the time it is sent, and nothing about
 * Hermes changes often enough to pay for that. `hermes_refresh_openapi` remains
 * for the case where it genuinely has.
 *
 * Never rejects. A failed fetch leaves the registry on the bundled snapshot,
 * which is the property that makes removing the timer safe — this server has
 * never needed the network to be useful.
 */
export const primeRegistry = async (
  registry: SchemaRegistry,
  config: PrimeConfig,
  logger: Logger,
  onRefreshed?: () => void
): Promise<void> => {
  try {
    const doc = await fetchOpenApiDoc(config.openApiDocsUrl, config.openApiFetchTimeoutMs);
    const stale = registry.refresh(doc, logger);
    onRefreshed?.();
    logger.info("openapi schema loaded", { stale: stale.length });
  } catch (err) {
    logger.warn("openapi schema fetch failed, keeping bundled snapshot", {
      error: errorMessage(err),
    });
  }
};
```

- [ ] **Step 4: Delete the config setting**

In `src/config.ts` delete the `rawInterval` / `openApiRefreshIntervalS` block (lines 46-52) and the `openApiRefreshIntervalS` field from both the `HermesMcpConfig` interface and the returned object. Delete `HERMES_OPENAPI_REFRESH_INTERVAL_S` from `.env`, from `.env.example`, and from the README's settings table.

- [ ] **Step 5: Update both call sites**

In `src/server.ts`, replace the `startOpenApiRefreshLoop(...)` call inside `createServer` with:

```ts
  void primeRegistry(runtime.registry, config, logger, () => {
    const changed = syncToolSchemas();
    if (changed.length > 0) logger.info("re-advertised refreshed tool schemas", { changed });
  });
```

In `src/httpServer.ts`, replace its `startOpenApiRefreshLoop(...)` call with `void primeRegistry(runtime.registry, config, logger);` — the per-request server reads the current registry every time, so it needs no re-advertise hook.

- [ ] **Step 6: Fix the refresh tool's now-false description**

`hermes_refresh_openapi`'s description (`src/tools/index.ts:322`) opens with "Recompile every other hermes_* tool's input schema from Hermes's live OpenAPI document, **without waiting for the background refresh interval**." There is no longer an interval to wait for. Replace that clause with "which this server reads once at startup and does not poll", keeping the rest of the description intact and above the 120-character floor.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. Any test referencing `startOpenApiRefreshLoop` or `openApiRefreshIntervalS` must be updated, not deleted — check `test/config.test.ts` for interval validation cases and remove only those asserting the deleted setting.

- [ ] **Step 8: Commit**

```bash
git add src/openapiSync.ts src/config.ts src/server.ts src/httpServer.ts src/tools/index.ts test/ .env.example README.md
git commit -m "$(cat <<'EOF'
refactor: fetch the OpenAPI spec once at startup instead of on a timer

A schema that changes underneath a live session invalidates calls an agent
has already composed, and Hermes does not change often enough to pay for
that. hermes_refresh_openapi remains for when it has.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `OperationIndex` — build and look up

**Files:**
- Create: `src/registry/operations.ts`
- Test: `test/registry/operations.test.ts`

**Interfaces:**
- Consumes: `OpenApiDocument`, `OpenApiOperation`, `OpenApiParameter` from `src/registry/schemaFromOpenApi.js`.
- Produces:
  ```ts
  export interface IndexedOperation {
    method: HttpMethod;
    path: string;              // template, e.g. "/api/v1/users/{id}"
    summary: string;
    description: string;
    tags: string[];
    parameters: OpenApiParameter[];
    operation: OpenApiOperation;
  }
  export class OperationIndex {
    static fromDocument(doc: OpenApiDocument): OperationIndex;
    get(method: string, path: string): IndexedOperation | undefined;
    all(): IndexedOperation[];
    nearest(method: string, path: string, limit?: number): string[];
    readonly size: number;
  }
  export const keyOf = (method: string, path: string): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/registry/operations.test.ts`:

```ts
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

  it("suggests near matches for a wrong key", () => {
    const index = OperationIndex.fromDocument(DOC);
    // Right path, wrong verb: the most common mistake, and the one worth naming.
    expect(index.nearest("delete", "/api/v1/users/{id}")).toContain("GET /api/v1/users/{id}");
  });

  it("ignores non-operation keys on a path item", () => {
    const withJunk = { paths: { "/x": { get: { summary: "X" }, parameters: [], servers: [] } } } as never;
    expect(OperationIndex.fromDocument(withJunk).size).toBe(1);
  });

  it("indexes the real bundled snapshot without throwing", () => {
    const index = OperationIndex.fromDocument(loadSnapshotDoc());
    expect(index.size).toBeGreaterThan(300);
    expect(index.get("get", "/api/v1/themes/active")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry/operations.test.ts`
Expected: FAIL — cannot resolve `../../src/registry/operations.js`.

- [ ] **Step 3: Implement the index**

Create `src/registry/operations.ts`:

```ts
import type {
  HttpMethod,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
} from "./schemaFromOpenApi.js";

/**
 * The methods this server will index. Deliberately not "every key on a path
 * item": an OpenAPI path item also carries `parameters`, `servers`, `summary`
 * and `$ref`, none of which is an operation, and treating them as one would
 * put un-callable entries in front of a model choosing what to call.
 *
 * `patch` is absent because Hermes has none — 141 get, 122 post, 59 put, 34
 * delete, 0 patch. Adding it would advertise a capability the API does not
 * have.
 */
const METHODS: HttpMethod[] = ["get", "post", "put", "delete"];

export interface IndexedOperation {
  method: HttpMethod;
  /** The path *template*, exactly as the document spells it. */
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: OpenApiParameter[];
  operation: OpenApiOperation;
}

/** The identity of an operation. Hermes' own `operationId`s are `read`, `update`, `delete_1` — useless. */
export const keyOf = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

export class OperationIndex {
  private constructor(private readonly byKey: Map<string, IndexedOperation>) {}

  static fromDocument(doc: OpenApiDocument): OperationIndex {
    const byKey = new Map<string, IndexedOperation>();
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (item === null || typeof item !== "object") continue;
      const pathLevel = Array.isArray((item as { parameters?: unknown }).parameters)
        ? ((item as { parameters: OpenApiParameter[] }).parameters)
        : [];
      for (const method of METHODS) {
        const operation = (item as Record<string, unknown>)[method] as OpenApiOperation | undefined;
        if (operation === undefined || operation === null || typeof operation !== "object") continue;
        byKey.set(keyOf(method, path), {
          method,
          path,
          summary: typeof operation.summary === "string" ? operation.summary : "",
          description: typeof operation.description === "string" ? operation.description : "",
          tags: Array.isArray(operation.tags) ? operation.tags.filter((t): t is string => typeof t === "string") : [],
          // Path-item parameters apply to every operation under it, so they are
          // merged in here rather than left for each caller to remember.
          parameters: [...pathLevel, ...(Array.isArray(operation.parameters) ? operation.parameters : [])],
          operation,
        });
      }
    }
    return new OperationIndex(byKey);
  }

  get(method: string, path: string): IndexedOperation | undefined {
    return this.byKey.get(keyOf(method, path));
  }

  all(): IndexedOperation[] {
    return [...this.byKey.values()];
  }

  /**
   * Keys close to one that did not match, for the error message.
   *
   * Same path under a different verb first — an agent that read a find result
   * and mistyped the method is the common case, and naming the verb that does
   * exist turns a dead end into a correction.
   */
  nearest(method: string, path: string, limit = 5): string[] {
    const samePath = this.all().filter((o) => o.path === path).map((o) => keyOf(o.method, o.path));
    const sameTail = this.all()
      .filter((o) => o.path !== path && o.path.split("/").pop() === path.split("/").pop())
      .map((o) => keyOf(o.method, o.path));
    return [...samePath, ...sameTail].slice(0, limit);
  }

  get size(): number {
    return this.byKey.size;
  }
}
```


- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry/operations.test.ts && npm run typecheck`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/registry/operations.ts test/registry/operations.test.ts
git commit -m "$(cat <<'EOF'
feat: index every Hermes operation by method and path

Hermes' operationIds are generated from verbs alone — read, update,
delete_1 — so method + path template is the only workable identity.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Path substitution, query coercion, `$ref` resolution

**Files:**
- Modify: `src/registry/operations.ts`
- Test: `test/registry/operations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const substitutePath = (template: string, params: Record<string, unknown>) => string;
  export const coerceQuery = (query: Record<string, unknown>) => Record<string, string>;
  export const resolveRefOnce = (doc: OpenApiDocument, schema: unknown) => unknown;
  ```
  `substitutePath` throws `InvalidPathParameterError` (`src/errors.ts:118`).

This task owns **Review Focus #3** (path escape) and **#5** (non-string values).

- [ ] **Step 1: Write the failing test**

Append to `test/registry/operations.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry/operations.test.ts`
Expected: FAIL — `substitutePath` is not exported.

- [ ] **Step 3: Implement**

Append to `src/registry/operations.ts`:

```ts
import { InvalidPathParameterError } from "../errors.js";

const PLACEHOLDER = /\{([^}]+)\}/g;

/**
 * Fills a path template from caller-supplied values.
 *
 * Every value is percent-encoded, without exception. A path parameter is the
 * one place a caller's string becomes part of the URL's structure rather than
 * its content, so a value of `../../admin` or `a/b?x=1` would not be a wrong
 * argument — it would be a different request, to an endpoint nobody chose.
 * Encoding turns it back into what it was meant to be: one segment.
 */
export const substitutePath = (template: string, params: Record<string, unknown>): string =>
  template.replace(PLACEHOLDER, (_match, name: string) => {
    const raw = params[name];
    if (raw === undefined || raw === null) {
      throw new InvalidPathParameterError(template, `no value given for {${name}}`);
    }
    if (typeof raw === "object") {
      throw new InvalidPathParameterError(template, `{${name}} was given an object, which is not an identifier`);
    }
    const text = String(raw).trim();
    if (text === "") {
      throw new InvalidPathParameterError(template, `{${name}} was given an empty value`);
    }
    return encodeURIComponent(text);
  });

/**
 * Narrows caller-supplied query values to the strings the transport takes.
 *
 * `HermesClient.request` types `query` as `Record<string, string>`, but a model
 * composing JSON writes `{page: 1}` and `{tags: ["a","b"]}` without thinking
 * about it. Coercing here is the difference between a working call and
 * `?page=[object Object]`, which Hermes rejects with an error about a parameter
 * the caller believes it sent correctly.
 *
 * Null and undefined are dropped rather than sent: `?a=null` is a filter on the
 * literal string "null", which is never what was meant.
 */
export const coerceQuery = (query: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const parts = value.filter((v) => v !== null && v !== undefined && typeof v !== "object");
      if (parts.length > 0) out[key] = parts.map((v) => String(v)).join(",");
      continue;
    }
    if (typeof value === "object") continue;
    out[key] = String(value);
  }
  return out;
};

/**
 * Replaces a `$ref` with the schema it names, one level only.
 *
 * One level is a size decision, not a correctness one. Hermes' component
 * schemas reference each other freely, and following them all for ten
 * candidates would return most of a 760 KB document to answer "is there an API
 * for this". A remaining `{"$ref": "#/components/schemas/Foo"}` is still
 * legible to a model, which can ask for that operation specifically.
 */
export const resolveRefOnce = (doc: OpenApiDocument, schema: unknown): unknown => {
  if (schema === null || typeof schema !== "object") return schema;
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") return schema;

  const name = ref.startsWith("#/components/schemas/") ? ref.slice("#/components/schemas/".length) : "";
  const components = (doc as { components?: { schemas?: Record<string, unknown> } }).components;
  const target = name === "" ? undefined : components?.schemas?.[name];
  // An unresolvable ref is handed back as-is: it names the shape, which is more
  // useful to a reader than silently becoming null.
  return target ?? schema;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry/operations.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry/operations.ts test/registry/operations.test.ts
git commit -m "$(cat <<'EOF'
feat: substitute, encode and coerce gateway request parameters

Path values are percent-encoded without exception — a path parameter is
where a caller's string becomes URL structure, and ../../admin is a
different request rather than a wrong argument.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Lexical search over the index

**Files:**
- Create: `src/registry/search.ts`
- Test: `test/registry/search.test.ts`

**Interfaces:**
- Consumes: `OperationIndex`, `IndexedOperation`, `resolveRefOnce` from Task 2/3.
- Produces:
  ```ts
  export interface ApiCandidate {
    method: string; path: string; summary: string; tags: string[];
    pathParams: ParamDoc[]; queryParams: ParamDoc[];
    requestBody: unknown | null; responseSchema: unknown | null;
  }
  export interface ParamDoc { name: string; type: string; required: boolean; description: string }
  export interface SearchResult { candidates: ApiCandidate[]; truncated: number }
  export const searchOperations = (
    index: OperationIndex, doc: OpenApiDocument,
    opts: { query: string; method?: string; limit?: number; maxBytes?: number }
  ) => SearchResult;
  ```

This task owns **Review Focus #4** (a single oversized candidate).

- [ ] **Step 1: Write the failing test**

Create `test/registry/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OperationIndex } from "../../src/registry/operations.js";
import { searchOperations } from "../../src/registry/search.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";

const DOC = loadSnapshotDoc();
const INDEX = OperationIndex.fromDocument(DOC);

describe("searchOperations", () => {
  it("puts the plain user read first for 'get user info'", () => {
    const { candidates } = searchOperations(INDEX, DOC, { query: "get user info" });
    expect(candidates[0]).toMatchObject({ method: "get", path: "/api/v1/users/{id}" });
  });

  it("filters by method", () => {
    const { candidates } = searchOperations(INDEX, DOC, { query: "user", method: "delete" });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.method === "delete")).toBe(true);
  });

  it("honours the limit", () => {
    expect(searchOperations(INDEX, DOC, { query: "store", limit: 3 }).candidates).toHaveLength(3);
  });

  it("describes path parameters of the operation it returns", () => {
    const { candidates } = searchOperations(INDEX, DOC, { query: "get user info", limit: 1 });
    expect(candidates[0].pathParams.map((p) => p.name)).toContain("id");
    expect(candidates[0].pathParams[0].required).toBe(true);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchOperations(INDEX, DOC, { query: "zzzznotathing" }).candidates).toHaveLength(0);
  });

  it("always returns at least one candidate even when it alone exceeds the cap", () => {
    // Review Focus #4: a naive cap returns an empty list and tells the agent
    // the API does not exist, which is a worse answer than a large one.
    const { candidates, truncated } = searchOperations(INDEX, DOC, { query: "get user info", maxBytes: 10 });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry/search.test.ts`
Expected: FAIL — cannot resolve `../../src/registry/search.js`.

- [ ] **Step 3: Implement**

Create `src/registry/search.ts`:

```ts
import type { OpenApiDocument, OpenApiParameter } from "./schemaFromOpenApi.js";
import { resolveRefOnce, type IndexedOperation, type OperationIndex } from "./operations.js";

export interface ParamDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiCandidate {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  pathParams: ParamDoc[];
  queryParams: ParamDoc[];
  requestBody: unknown | null;
  responseSchema: unknown | null;
}

export interface SearchResult {
  candidates: ApiCandidate[];
  /** How many ranked matches were dropped to stay under the byte cap. */
  truncated: number;
}

/** 60 KB. Large enough for ten hydrated operations, small enough not to swamp a context window. */
const DEFAULT_MAX_BYTES = 60_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

/**
 * Scores one operation against the query's tokens.
 *
 * Weights descend by how deliberately the text was written: a path segment is
 * the API's own noun and is almost always what a question is about, a summary
 * is written for a human, tags group loosely, and descriptions are long enough
 * that a token match in one means little. Exact segment equality outranks a
 * substring so that "user" prefers /users/{id} over /store-users-report.
 */
const score = (op: IndexedOperation, tokens: string[]): number => {
  const segments = op.path.toLowerCase().split("/").filter(Boolean).map((s) => s.replace(/[{}]/g, ""));
  const summary = tokenize(op.summary);
  const tags = op.tags.map((t) => t.toLowerCase());
  const description = tokenize(op.description);

  let total = 0;
  for (const token of tokens) {
    if (segments.includes(token)) total += 10;
    else if (segments.some((s) => s.includes(token))) total += 4;
    if (summary.includes(token)) total += 5;
    if (tags.some((t) => t.includes(token))) total += 2;
    if (description.includes(token)) total += 1;
  }
  return total;
};

const paramDocs = (parameters: OpenApiParameter[], where: string): ParamDoc[] =>
  parameters
    .filter((p) => p.in === where)
    .map((p) => ({
      name: p.name,
      type: typeof p.schema?.type === "string" ? p.schema.type : "string",
      required: p.required === true,
      description: typeof (p as { description?: unknown }).description === "string"
        ? (p as { description: string }).description
        : "",
    }));

const hydrate = (doc: OpenApiDocument, op: IndexedOperation): ApiCandidate => {
  const operation = op.operation as unknown as {
    requestBody?: { content?: Record<string, { schema?: unknown }> };
    responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  };
  const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  const okResponse = operation.responses?.["200"] ?? operation.responses?.["201"];
  const responseSchema = okResponse?.content?.["application/json"]?.schema;

  return {
    method: op.method,
    path: op.path,
    summary: op.summary,
    tags: op.tags,
    pathParams: paramDocs(op.parameters, "path"),
    queryParams: paramDocs(op.parameters, "query"),
    requestBody: bodySchema === undefined ? null : resolveRefOnce(doc, bodySchema),
    responseSchema: responseSchema === undefined ? null : resolveRefOnce(doc, responseSchema),
  };
};

export const searchOperations = (
  index: OperationIndex,
  doc: OpenApiDocument,
  opts: { query: string; method?: string; limit?: number; maxBytes?: number }
): SearchResult => {
  const tokens = tokenize(opts.query);
  const wanted = opts.method?.toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const ranked = index
    .all()
    .filter((op) => wanted === undefined || op.method === wanted)
    .map((op) => ({ op, points: score(op, tokens) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      // Ties: a read before a write, then the shorter path — the general
      // operation before the special case.
      if (a.op.method !== b.op.method) return a.op.method === "get" ? -1 : b.op.method === "get" ? 1 : 0;
      return a.op.path.length - b.op.path.length;
    })
    .slice(0, limit);

  const candidates: ApiCandidate[] = [];
  let bytes = 0;
  for (const entry of ranked) {
    const candidate = hydrate(doc, entry.op);
    const size = JSON.stringify(candidate).length;
    // The first candidate goes in whatever it costs. An empty result reads as
    // "no such API", which is a wrong answer; an oversized single result is
    // merely an expensive right one.
    if (candidates.length > 0 && bytes + size > maxBytes) break;
    candidates.push(candidate);
    bytes += size;
  }

  return { candidates, truncated: ranked.length - candidates.length };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry/search.test.ts && npm run typecheck`
Expected: PASS, 7 tests. If the "get user info" ranking test fails, inspect the top five results and adjust the weights in `score` — do not change the test's expectation, which encodes the spec's stated example.

- [ ] **Step 5: Commit**

```bash
git add src/registry/search.ts test/registry/search.test.ts
git commit -m "$(cat <<'EOF'
feat: rank Hermes operations lexically against a natural-language query

Path segments outweigh summaries outweigh tags outweigh descriptions, by
how deliberately each was written. A byte cap keeps a 760 KB document from
answering "is there an API for this".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Hold the index on the runtime

**Files:**
- Modify: `src/server.ts` (`ServerRuntime`, `createRuntime`, `buildServer`)
- Modify: `src/tools/index.ts` (`ToolContext`, `hermes_refresh_openapi` handler)
- Modify: `src/openapiSync.ts` (`primeRegistry` also refreshes the index)
- Test: `test/server.test.ts` or `test/integration.test.ts`

**Interfaces:**
- Produces: `ServerRuntime.operations: OperationIndex` and `ServerRuntime.doc: OpenApiDocument`; `ToolContext.operations` and `ToolContext.doc`; a runtime setter so a refresh can swap both.

- [ ] **Step 1: Write the failing test**

Append to `test/integration.test.ts`:

```ts
it("exposes the operation index on the runtime, built from the snapshot", () => {
  const runtime = createRuntime();
  expect(runtime.operations.size).toBeGreaterThan(300);
  expect(runtime.operations.get("get", "/api/v1/themes/active")).toBeDefined();
});
```

Import `createRuntime` from `../src/server.js` if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — `operations` does not exist on `ServerRuntime`.

- [ ] **Step 3: Implement**

In `src/server.ts`, extend `ServerRuntime`:

```ts
export interface ServerRuntime {
  config: HermesMcpConfig;
  logger: Logger;
  registry: SchemaRegistry;
  tokens: TokenCache;
  /**
   * Every operation Hermes publishes, not just the twelve this server curates.
   *
   * Held separately from `registry` because they answer different questions.
   * `SchemaRegistry` compiles the allowlist and discards the document; the
   * gateway needs the document itself, and rebuilding it per request would
   * mean parsing 760 KB on every tool call.
   */
  operations: OperationIndex;
  /** The document the index was built from, for resolving `$ref`s at search time. */
  doc: OpenApiDocument;
}
```

In `createRuntime`, build the document once and share it:

```ts
export const createRuntime = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config)
): ServerRuntime => {
  const doc = loadSnapshotDoc();
  return {
    config,
    logger,
    registry: SchemaRegistry.fromDocument(doc),
    tokens: new TokenCache(config.hermesBaseUrl),
    operations: OperationIndex.fromDocument(doc),
    doc,
  };
};
```

In `buildServer`, pass `operations` and `doc` into the `registerHermesTools` context, and add both to `ToolContext` in `src/tools/index.ts`:

```ts
  /** Every Hermes operation, for the gateway tools. */
  operations: OperationIndex;
  /** The document those operations came from. */
  doc: OpenApiDocument;
```

Change `primeRegistry` (Task 1) to take the runtime rather than the registry alone, so a successful fetch replaces the index too:

```ts
export const primeRegistry = async (
  runtime: { registry: SchemaRegistry; operations: OperationIndex; doc: OpenApiDocument },
  config: PrimeConfig,
  logger: Logger,
  onRefreshed?: () => void
): Promise<void> => {
  try {
    const doc = await fetchOpenApiDoc(config.openApiDocsUrl, config.openApiFetchTimeoutMs);
    const stale = runtime.registry.refresh(doc, logger);
    runtime.operations = OperationIndex.fromDocument(doc);
    runtime.doc = doc;
    onRefreshed?.();
    logger.info("openapi schema loaded", { stale: stale.length, operations: runtime.operations.size });
  } catch (err) {
    logger.warn("openapi schema fetch failed, keeping bundled snapshot", { error: errorMessage(err) });
  }
};
```

This changes `primeRegistry`'s first parameter from a `SchemaRegistry` to the runtime. **Task 1's tests call it with a bare registry and must be updated here** — pass `{registry, operations, doc}` instead, and add an assertion that a successful fetch replaces `runtime.operations`. Update both call sites accordingly, and make the same substitution inside the `hermes_refresh_openapi` handler in `src/tools/index.ts` so the manual refresh rebuilds the index as well. Report the operation count in its returned JSON alongside `refreshed`, `changed` and `stale`.

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/tools/index.ts src/openapiSync.ts test/
git commit -m "$(cat <<'EOF'
feat: hold the full operation index on the server runtime

SchemaRegistry compiles the allowlist and discards the document; the
gateway needs the document, and parsing 760 KB per request is not an
option.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `hermes_find_api` and `hermes_call_api`

**Files:**
- Create: `src/tools/gateway.ts`
- Modify: `src/tools/index.ts` (register them; lift the store guard)
- Modify: `src/errors.ts` (add `UNKNOWN_OPERATION`)
- Test: `test/tools/gateway.test.ts`

**Interfaces:**
- Consumes: `searchOperations`, `OperationIndex`, `substitutePath`, `coerceQuery`, `ToolContext`, `userContextFrom`, `sendWithRenewal`, `toToolResult`.
- Produces: `registerGatewayTools(server: McpServer, ctx: ToolContext): void`; `assertStoreIds(candidates: unknown[], user: UserContext): void` exported from `src/tools/index.ts`.

This task owns **Review Focus #1** (opaque unknown operation) and **#2** (nested `storeId`).

- [ ] **Step 1: Write the failing test**

Create `test/tools/gateway.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { OperationIndex } from "../../src/registry/operations.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { registerGatewayTools } from "../../src/tools/gateway.js";
import { createLogger } from "../../src/logging.js";
import { StoreMismatchError } from "../../src/errors.js";

const doc = loadSnapshotDoc();
const logger = createLogger({ logLevel: "silent" } as never);
const USER = { accessToken: "t", storeId: "str_1" };

const contextWith = (request: ReturnType<typeof vi.fn>) => ({
  config: { credentials: USER, hermesBaseUrl: "https://hermes.test" } as never,
  logger,
  registry: { get: () => { throw new Error("unused"); }, list: () => [] } as never,
  createClient: () => ({ request }),
  operations: OperationIndex.fromDocument(doc),
  doc,
  allowEnvFallback: true,
});

/** Calls one registered tool by name, the way the SDK would. */
const callTool = async (ctx: never, name: string, args: Record<string, unknown>) => {
  const server = new McpServer({ name: "t", version: "0" });
  const handlers = new Map<string, (a: Record<string, unknown>, c: unknown) => Promise<unknown>>();
  const spy = { registerTool: (n: string, _d: unknown, h: never) => handlers.set(n, h) } as never;
  registerGatewayTools(spy, ctx);
  void server;
  return handlers.get(name)!(args, { mcpReq: { _meta: {} } });
};

describe("hermes_find_api", () => {
  it("returns candidates without calling Hermes", async () => {
    const request = vi.fn();
    const result = (await callTool(contextWith(request) as never, "hermes_find_api", {
      query: "get user info",
    })) as { content: [{ text: string }] };

    expect(request).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text) as { candidates: { path: string }[] };
    expect(payload.candidates[0].path).toBe("/api/v1/users/{id}");
  });
});

describe("hermes_call_api", () => {
  it("invokes the operation through HermesClient", async () => {
    const request = vi.fn(async () => ({ id: "usr_1" }));
    const result = (await callTool(contextWith(request) as never, "hermes_call_api", {
      method: "get",
      path: "/api/v1/users/{id}",
      pathParams: { id: "usr_1" },
    })) as { content: [{ text: string }] };

    expect(request).toHaveBeenCalledWith("get", "/api/v1/users/usr_1", { query: {}, body: undefined });
    expect(JSON.parse(result.content[0].text)).toEqual({ id: "usr_1" });
  });

  it("refuses an operation the document does not have, and sends nothing", async () => {
    // Review Focus #1: this must read as UNKNOWN_OPERATION, not as an opaque
    // "failed unexpectedly, reference <hex>".
    const request = vi.fn();
    const result = (await callTool(contextWith(request) as never, "hermes_call_api", {
      method: "delete",
      path: "/api/v1/users/{id}",
      pathParams: { id: "usr_1" },
    })) as { content: [{ text: string }]; isError: true };

    expect(request).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[UNKNOWN_OPERATION]");
    expect(result.content[0].text).toContain("GET /api/v1/users/{id}");
  });

  it("refuses a missing path parameter and sends nothing", async () => {
    const request = vi.fn();
    const result = (await callTool(contextWith(request) as never, "hermes_call_api", {
      method: "get",
      path: "/api/v1/users/{id}",
      pathParams: {},
    })) as { content: [{ text: string }]; isError: true };

    expect(request).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("[INVALID_PATH_PARAM]");
  });

  it("refuses another merchant's store id in pathParams", async () => {
    // Review Focus #2: the flat guard would not have seen this.
    const request = vi.fn();
    const result = (await callTool(contextWith(request) as never, "hermes_call_api", {
      method: "get",
      path: "/api/v1/stores/{id}/info",
      pathParams: { id: "str_SOMEONE_ELSE" },
      body: { storeId: "str_SOMEONE_ELSE" },
    })) as { content: [{ text: string }]; isError: true };

    expect(request).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("[STORE_MISMATCH]");
  });

  it("refuses another merchant's store id in the body", async () => {
    const request = vi.fn();
    const result = (await callTool(contextWith(request) as never, "hermes_call_api", {
      method: "put",
      path: "/api/v1/themes/{id}",
      pathParams: { id: "thm_1" },
      body: { storeId: "str_SOMEONE_ELSE" },
    })) as { content: [{ text: string }]; isError: true };

    expect(request).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("[STORE_MISMATCH]");
  });
});
```

If `registerGatewayTools` registers via a different SDK method than `registerTool`, match whatever `registerHermesTools` in `src/tools/index.ts` already uses and adjust the `spy` shape in this test to suit.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/gateway.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/gateway.js`.

- [ ] **Step 3: Add the missing error code**

In `src/errors.ts`, add to `KNOWN_ERROR_CODES` (after the `InvalidPathParameterError` entry):

```ts
  [MissingOperationError, "UNKNOWN_OPERATION"],
```

`MissingOperationError` is already defined at line 125 but was never mapped, so it has been surfacing as "The tool failed unexpectedly. Reference `<hex>`" — accurate about nothing and actionable by no one.

- [ ] **Step 4: Lift the store guard**

In `src/tools/index.ts`, replace `assertActingOnOwnStore` with a form that takes candidate ids rather than an argument bag, and keep a thin wrapper for the twelve curated tools:

```ts
/**
 * Refuses a call that names a store other than the credential's own.
 *
 * Takes the candidate ids rather than the argument bag because the gateway
 * nests them: a curated tool's `storeId` is a top-level argument, while
 * `hermes_call_api` carries it inside `pathParams` or `body`. Reading only the
 * top level, as this did, would have let a gateway call address another
 * merchant's store — authorised by the caller's own token, and therefore
 * returning data rather than an error.
 */
export const assertStoreIds = (candidates: unknown[], user: UserContext): void => {
  for (const named of candidates) {
    if (named === undefined || named === null) continue;
    const asText = typeof named === "number" ? String(named) : named;
    if (typeof asText !== "string" || asText === "") continue;
    if (asText !== user.storeId) throw new StoreMismatchError(asText, user.storeId);
  }
};

const assertActingOnOwnStore = (args: Record<string, unknown>, user: UserContext): void =>
  assertStoreIds([args.storeId], user);
```

- [ ] **Step 5: Implement the gateway**

Create `src/tools/gateway.ts`:

```ts
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { MissingOperationError, toToolResult } from "../errors.js";
import { coerceQuery, substitutePath } from "../registry/operations.js";
import { searchOperations } from "../registry/search.js";
import { userContextFrom } from "../userContext.js";
import { assertStoreIds, sendWithRenewal, type CallContext, type ToolContext, type ToolReturn } from "./index.js";

const FIND_DESCRIPTION =
  "Search Hermes' live OpenAPI specification for the operation that answers a question, and return its method, " +
  "path, parameters and request and response schemas. Use this when none of the purpose-built hermes_* tools " +
  "covers what you need — those tools handle themes, pages, widgets and custom blocks with better schemas and " +
  "should always be preferred where they apply. This tool only describes operations; it never calls anything, " +
  "so it is safe to explore with. Follow up with hermes_call_api to invoke what you find.";

const CALL_DESCRIPTION =
  "Invoke any operation in Hermes' OpenAPI specification by its method and path template, for example method " +
  "'get' and path '/api/v1/users/{id}'. Prefer the purpose-built hermes_* tools where they apply; use this for " +
  "everything they do not cover, normally after hermes_find_api has told you the exact path and parameters. " +
  "THIS TOOL CAN MODIFY AND DELETE DATA: post, put and delete operations take effect immediately and " +
  "irreversibly, using the caller's own credentials. This server cannot ask a human for confirmation — it has " +
  "no channel to one — so confirm any non-GET call with the user before making it.";

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const registerGatewayTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "hermes_find_api",
    {
      description: FIND_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().describe("What you are trying to do, in words. For example: get user info"),
        method: z.enum(["get", "post", "put", "delete"]).optional().describe("Restrict results to one HTTP method"),
        limit: z.number().int().min(1).max(25).optional().describe("How many candidates to return. Default 10"),
      }),
    },
    (async (args: Record<string, unknown>): Promise<ToolReturn> => {
      try {
        const result = searchOperations(ctx.operations, ctx.doc, {
          query: String(args.query ?? ""),
          ...(typeof args.method === "string" ? { method: args.method } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
        ctx.logger.info("api search", {
          tool: "hermes_find_api",
          found: result.candidates.length,
          truncated: result.truncated,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return toToolResult(err, ctx.logger, "hermes_find_api");
      }
    }) as Parameters<typeof server.registerTool>[2]
  );

  server.registerTool(
    "hermes_call_api",
    {
      description: CALL_DESCRIPTION,
      inputSchema: z.object({
        method: z.enum(["get", "post", "put", "delete"]).describe("The HTTP method, exactly as hermes_find_api reported it"),
        path: z.string().describe("The path TEMPLATE with its braces intact, e.g. /api/v1/users/{id}"),
        pathParams: z.record(z.string(), z.unknown()).optional().describe("A value for every {placeholder} in the path"),
        query: z.record(z.string(), z.unknown()).optional().describe("Query string parameters"),
        body: z.unknown().optional().describe("JSON request body, for post and put"),
      }),
    },
    (async (args: Record<string, unknown>, call: CallContext): Promise<ToolReturn> => {
      const start = Date.now();
      const traceId = randomBytes(4).toString("hex");
      const method = String(args.method ?? "").toLowerCase();
      const template = String(args.path ?? "");

      try {
        // Before anything else, and before any credential is resolved: an
        // operation Hermes does not publish is not a request this server will
        // compose. This is what keeps the gateway bounded by Hermes' own
        // surface rather than being an arbitrary HTTP client.
        const operation = ctx.operations.get(method, template);
        if (operation === undefined) {
          const near = ctx.operations.nearest(method, template);
          throw new MissingOperationError(
            near.length === 0 ? "hermes_call_api" : `hermes_call_api (did you mean: ${near.join(", ")})`,
            method,
            template
          );
        }

        const pathParams = asRecord(args.pathParams);
        const query = asRecord(args.query);
        const body = args.body;

        const user = userContextFrom(
          call?.mcpReq?._meta,
          ctx.httpCredentials,
          ctx.allowEnvFallback === false ? null : ctx.config.credentials
        );

        // Three places a store id can hide in a gateway call, against one in a
        // curated one. Checked before the path is built, so a cross-tenant call
        // costs nothing and reaches nothing.
        assertStoreIds([args.storeId, pathParams.storeId, asRecord(body).storeId], user);

        const path = substitutePath(template, pathParams);
        const resolvedQuery = coerceQuery(query);

        if (method !== "get") {
          // The one line that makes a destructive call greppable afterwards.
          ctx.logger.warn("gateway write call", { tool: "hermes_call_api", traceId, method, path });
        }

        const data = await sendWithRenewal(
          ctx,
          user,
          (acting) => ctx.createClient(acting).request(method, path, { query: resolvedQuery, body }),
          (reason) => ctx.logger.info("renewed hermes session", { tool: "hermes_call_api", traceId, reason })
        );

        ctx.logger.info("tool call ok", {
          tool: "hermes_call_api",
          traceId,
          method,
          durationMs: Date.now() - start,
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err) {
        ctx.logger.info("tool call failed", {
          tool: "hermes_call_api",
          traceId,
          durationMs: Date.now() - start,
        });
        return toToolResult(err, ctx.logger, "hermes_call_api");
      }
    }) as Parameters<typeof server.registerTool>[2]
  );
};
```

`sendWithRenewal`, `ToolReturn` and `CallContext` are currently module-private in `src/tools/index.ts`. Export all three (and `assertStoreIds` from Step 4) so `gateway.ts` can use them; do not duplicate the renewal logic.

- [ ] **Step 6: Register them**

In `src/tools/index.ts`, call `registerGatewayTools(server, ctx)` from `registerHermesTools`, after the twelve curated tools and `hermes_refresh_openapi`, so the curated tools are listed first.

- [ ] **Step 7: Run tests**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. Six new gateway tests plus the existing suite.

- [ ] **Step 8: Commit**

```bash
git add src/tools/gateway.ts src/tools/index.ts src/errors.ts test/tools/gateway.test.ts
git commit -m "$(cat <<'EOF'
feat: add hermes_find_api and hermes_call_api

Any Hermes operation is now reachable by method and path. The cross-store
guard is lifted to read nested ids — the flat version would not have seen a
storeId inside pathParams or body — and MissingOperationError is finally
mapped to UNKNOWN_OPERATION instead of an opaque correlation id.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Integration coverage and documentation

**Files:**
- Modify: `test/integration.test.ts`
- Modify: `scripts/inspect-smoke.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

Append to `test/integration.test.ts`:

```ts
it("advertises both gateway tools with usable descriptions", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain("hermes_find_api");
  expect(names).toContain("hermes_call_api");

  for (const name of ["hermes_find_api", "hermes_call_api"]) {
    const tool = tools.find((t) => t.name === name)!;
    expect(tool.description!.length).toBeGreaterThanOrEqual(120);
  }
  // The destructive warning is the one line that must survive any edit.
  const call = tools.find((t) => t.name === "hermes_call_api")!;
  expect(call.description).toMatch(/MODIFY AND DELETE/);
});

it("lists the curated tools before the gateway", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names.indexOf("hermes_get_active_theme")).toBeLessThan(names.indexOf("hermes_call_api"));
});

it("refuses a gateway call with no credentials before reaching the network", async () => {
  const result = await client.callTool({
    name: "hermes_call_api",
    arguments: { method: "get", path: "/api/v1/users/{id}", pathParams: { id: "usr_1" } },
  });
  expect(result.isError).toBe(true);
  expect((result.content as [{ text: string }])[0].text).toContain("[MISSING_CREDENTIALS]");
});
```

The credentials test must run against a server built with `allowEnvFallback: false`, matching how the existing no-credentials tests in this file are set up.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration.test.ts`
Expected: FAIL — the gateway tools are not advertised if Task 6's registration was missed.

- [ ] **Step 3: Update the smoke script**

In `scripts/inspect-smoke.mjs`, add `hermes_find_api` and `hermes_call_api` to the expected tool list and assert the 120-char description floor for both, matching how the existing tools are checked. Do not add a `tools/call` case for `hermes_call_api` — the script's dead-host convention would make it indistinguishable from a real invocation attempt.

- [ ] **Step 4: Update the README**

Add a section documenting both tools: the argument shapes from Task 6, the preference for curated tools, the destructive warning, and that `HERMES_OPENAPI_REFRESH_INTERVAL_S` is gone and the spec is now fetched once at startup with `hermes_refresh_openapi` as the manual refresh.

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npx vitest run && npm run build && npm run inspect:smoke`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add test/integration.test.ts scripts/inspect-smoke.mjs README.md
git commit -m "$(cat <<'EOF'
test: cover the gateway tools at the protocol edge, and document them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
