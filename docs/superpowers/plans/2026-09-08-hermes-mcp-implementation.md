# hermes-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `hermes-mcp`, a stdio MCP server exposing 11 curated Hermes Atlas
REST endpoints as tools, with credentials read once from the environment per
process and tool schemas kept in sync with Hermes's live OpenAPI contract.

**Architecture:** One TypeScript source tree (`src/`) compiled by esbuild into a
single stdio-served bundle (`dist/server.js`), mirroring `vajro-custom-blocks-sdk/mcp`'s
shape exactly (`McpServer` + `serveStdio`, structured stderr logging, eager config
validation, vitest). A small allowlist (`src/registry/endpoints.ts`) is the only
place a Hermes operation can be exposed; a pure resolver
(`src/registry/schemaFromOpenApi.ts`) turns an allowlist entry plus an OpenAPI
document into a Zod input schema, used both to compile the checked-in snapshot at
startup and to refresh schemas from the live spec on an interval. Every tool call
goes through one Hermes client built once per process from
`HERMES_ACCESS_TOKEN`/`HERMES_STORE_ID`, and one `wrap()` maps its outcome to a
structured MCP tool result.

**Tech Stack:** Node 20, TypeScript 5.7, `@modelcontextprotocol/server` v2 (stdio
transport), Zod v4, esbuild, vitest, `@modelcontextprotocol/client` v2 (test-only,
for `InMemoryTransport`).

**Spec:** `docs/superpowers/specs/2026-09-08-hermes-mcp-design.md`

## Global Constraints

- Never write to stdout anywhere under `src/` — stdout is the MCP transport; the
  logger writes to stderr only (spec hard constraint #1).
- Never store a credential outside the process it was configured for — one
  `hermes-mcp` process serves exactly one Hermes identity for its life (spec hard
  constraint #2).
- Never expose a Hermes operation that isn't a named entry in
  `src/registry/endpoints.ts` — no dynamic/generic path construction from caller
  input (spec hard constraint #3).
- Never log a token, at any log level — the logger redacts token-shaped fields as
  a second line of defence (spec hard constraint #4).
- `HERMES_BASE_URL` and `HERMES_OPENAPI_DOCS_URL` are separate settings on
  separate hosts/paths and must never be derived from one another.
- Node ≥20, TypeScript strict mode, ESM (`"type": "module"`).
- Every allowlisted operation's request body is a deliberate passthrough
  (`z.record(z.string(), z.unknown())`) — Hermes validates its own DTOs; this
  server does not re-implement that validation.

---

### Task 1: Repo scaffold + config module

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `export type LogLevel = "silent" | "error" | "warn" | "info" | "debug"`
- Produces: `export interface HermesMcpConfig { logLevel: LogLevel; serverName: string; serverVersion: string; hermesBaseUrl: string; openApiDocsUrl: string; openApiRefreshIntervalS: number; openApiFetchTimeoutMs: number; credentials: { accessToken: string; storeId: string } | null }`
- Produces: `export const loadConfig: (env?: NodeJS.ProcessEnv) => HermesMcpConfig`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@superfans/hermes-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "hermes-mcp": "./dist/server.js"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@types/node": "^20.14.0",
    "esbuild": "^0.28.2",
    "typescript": "^5.7.3",
    "vitest": "^3.2.7"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 5: Create `.env.example`**

```bash
# Minimum severity that reaches stderr: silent | error | warn | info | debug
HERMES_MCP_LOG_LEVEL=info

# Host root Hermes Atlas tool calls go to (NOT the OpenAPI docs URL below)
HERMES_BASE_URL=https://hermes-atlas.vjr-dev.com

# Where the live OpenAPI spec is fetched from, to keep tool schemas current
HERMES_OPENAPI_DOCS_URL=https://hermes-atlas.vajro.com/v3/api-docs
HERMES_OPENAPI_REFRESH_INTERVAL_S=900

# This process's Hermes identity. Set both together, or neither.
# tools/list works with neither set; any tool call fails with MISSING_CREDENTIALS.
HERMES_ACCESS_TOKEN=
HERMES_STORE_ID=
```

- [ ] **Step 6: Run `npm install`**

Run: `npm install`
Expected: installs cleanly, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 7: Write the failing test for `loadConfig`**

Create `test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const config = loadConfig({});
    expect(config.logLevel).toBe("info");
    expect(config.hermesBaseUrl).toBe("https://hermes-atlas.vjr-dev.com");
    expect(config.openApiDocsUrl).toBe("https://hermes-atlas.vajro.com/v3/api-docs");
    expect(config.openApiRefreshIntervalS).toBe(900);
    expect(config.credentials).toBeNull();
  });

  it("rejects an invalid log level", () => {
    expect(() => loadConfig({ HERMES_MCP_LOG_LEVEL: "verbose" })).toThrow(
      /HERMES_MCP_LOG_LEVEL/
    );
  });

  it("rejects a non-positive refresh interval", () => {
    expect(() => loadConfig({ HERMES_OPENAPI_REFRESH_INTERVAL_S: "0" })).toThrow(
      /HERMES_OPENAPI_REFRESH_INTERVAL_S/
    );
  });

  it("requires access token and store id together", () => {
    expect(() => loadConfig({ HERMES_ACCESS_TOKEN: "t" })).toThrow(/together/);
    expect(() => loadConfig({ HERMES_STORE_ID: "s" })).toThrow(/together/);
  });

  it("builds credentials when both are set", () => {
    const config = loadConfig({ HERMES_ACCESS_TOKEN: "t", HERMES_STORE_ID: "s" });
    expect(config.credentials).toEqual({ accessToken: "t", storeId: "s" });
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `src/config.ts` does not exist yet.

- [ ] **Step 9: Create `src/config.ts`**

```ts
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

export interface HermesMcpConfig {
  logLevel: LogLevel;
  serverName: string;
  serverVersion: string;
  hermesBaseUrl: string;
  openApiDocsUrl: string;
  openApiRefreshIntervalS: number;
  openApiFetchTimeoutMs: number;
  credentials: { accessToken: string; storeId: string } | null;
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): HermesMcpConfig => {
  const rawLogLevel = env.HERMES_MCP_LOG_LEVEL;
  if (rawLogLevel !== undefined && !LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new Error(
      `Invalid HERMES_MCP_LOG_LEVEL "${rawLogLevel}". Allowed values: ${LOG_LEVELS.join(", ")}.`
    );
  }

  const rawInterval = env.HERMES_OPENAPI_REFRESH_INTERVAL_S;
  const openApiRefreshIntervalS = rawInterval === undefined ? 900 : Number(rawInterval);
  if (!Number.isFinite(openApiRefreshIntervalS) || openApiRefreshIntervalS <= 0) {
    throw new Error(
      `Invalid HERMES_OPENAPI_REFRESH_INTERVAL_S "${rawInterval}". Must be a positive number of seconds.`
    );
  }

  const accessToken = env.HERMES_ACCESS_TOKEN;
  const storeId = env.HERMES_STORE_ID;
  if ((accessToken && !storeId) || (!accessToken && storeId)) {
    throw new Error("HERMES_ACCESS_TOKEN and HERMES_STORE_ID must be set together, or neither.");
  }

  return {
    logLevel: (rawLogLevel as LogLevel | undefined) ?? "info",
    serverName: "hermes-mcp",
    serverVersion: "0.1.0",
    hermesBaseUrl: env.HERMES_BASE_URL ?? "https://hermes-atlas.vjr-dev.com",
    openApiDocsUrl: env.HERMES_OPENAPI_DOCS_URL ?? "https://hermes-atlas.vajro.com/v3/api-docs",
    openApiRefreshIntervalS,
    openApiFetchTimeoutMs: 10_000,
    credentials: accessToken && storeId ? { accessToken, storeId } : null,
  };
};
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts test/config.test.ts
git commit -m "feat: scaffold hermes-mcp repo and add config module"
```

---

### Task 2: Logging module

**Files:**
- Create: `src/logging.ts`
- Test: `test/logging.test.ts`

**Interfaces:**
- Consumes: `LogLevel` from `src/config.ts` (Task 1)
- Produces: `export interface Logger { debug(message: string, meta?: Record<string, unknown>): void; info(...): void; warn(...): void; error(...): void }`
- Produces: `export const createLogger: (config: { logLevel: LogLevel }, write?: (line: string) => void) => Logger`

- [ ] **Step 1: Write the failing tests**

Create `test/logging.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging.js";

describe("createLogger", () => {
  it("writes JSON lines only at or above the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "warn" }, (line) => lines.push(line));

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).message).toBe("warn message");
    expect(JSON.parse(lines[1]).message).toBe("error message");
  });

  it("never writes to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write");
    const logger = createLogger({ logLevel: "debug" });
    logger.info("hello");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("redacts a token-shaped field even if a caller passes one by mistake", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));
    logger.info("oops", { authorization: "Bearer secret", accessToken: "secret2", other: "fine" });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.authorization).toBe("[REDACTED]");
    expect(parsed.accessToken).toBe("[REDACTED]");
    expect(parsed.other).toBe("fine");
  });

  it("writes silent level as nothing at all", () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "silent" }, (line) => lines.push(line));
    logger.error("should not appear");
    expect(lines).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/logging.test.ts`
Expected: FAIL — `src/logging.ts` does not exist yet.

- [ ] **Step 3: Create `src/logging.ts`**

```ts
import type { LogLevel } from "./config.js";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const REDACTED_KEYS = new Set(["authorization", "accesstoken", "token", "password"]);

const redact = (meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
};

export const createLogger = (
  config: { logLevel: LogLevel },
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  }
): Logger => {
  const threshold = LEVEL_ORDER[config.logLevel];
  const log = (
    level: Exclude<LogLevel, "silent">,
    message: string,
    meta?: Record<string, unknown>
  ): void => {
    if (LEVEL_ORDER[level] > threshold) return;
    write(JSON.stringify({ level, message, ts: new Date().toISOString(), ...redact(meta) }) + "\n");
  };
  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/logging.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logging.ts test/logging.test.ts
git commit -m "feat: add structured stderr logger with token redaction"
```

---

### Task 3: Errors module

**Files:**
- Create: `src/errors.ts`
- Test: `test/errors.test.ts`

**Interfaces:**
- Consumes: `Logger` from `src/logging.ts` (Task 2)
- Produces: `HermesUnauthenticatedError`, `HermesForbiddenError`, `HermesNotFoundError`, `HermesRejectedError`, `HermesUnavailableError`, `MissingCredentialsError`, `MissingOperationError` (all `Error` subclasses)
- Produces: `export const errorMessage: (err: unknown) => string`
- Produces: `export interface ToolResult { content: [{ type: "text"; text: string }]; isError: true }`
- Produces: `export const toToolResult: (error: unknown, logger: Logger, tool: string) => ToolResult`

- [ ] **Step 1: Write the failing tests**

Create `test/errors.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging.js";
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
  MissingCredentialsError,
  MissingOperationError,
  errorMessage,
  toToolResult,
} from "../src/errors.js";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies a non-Error", () => {
    expect(errorMessage("boom")).toBe("boom");
  });
});

describe("toToolResult", () => {
  const cases: [Error, string][] = [
    [new HermesUnauthenticatedError("/x"), "UNAUTHENTICATED"],
    [new HermesForbiddenError("/x"), "FORBIDDEN"],
    [new HermesNotFoundError("/x"), "NOT_FOUND"],
    [new HermesRejectedError("/x", 422, "bad body"), "REJECTED"],
    [new HermesUnavailableError("/x", new Error("down")), "UNAVAILABLE"],
    [new MissingCredentialsError(), "MISSING_CREDENTIALS"],
  ];

  it.each(cases)("maps %s to a visible, coded tool result", (error, code) => {
    const logger = createLogger({ logLevel: "silent" });
    const result = toToolResult(error, logger, "hermes_get_widget");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`[${code}]`);
  });

  it("hides an unrecognised error behind a correlation id instead of its raw message", () => {
    const logger = createLogger({ logLevel: "silent" });
    const errorSpy = vi.spyOn(logger, "error");
    const result = toToolResult(new TypeError("unexpected internal bug"), logger, "hermes_get_widget");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("unexpected internal bug");
    expect(result.content[0].text).toMatch(/reference/i);
    expect(errorSpy).toHaveBeenCalledWith(
      "tool call failed unexpectedly",
      expect.objectContaining({ tool: "hermes_get_widget" })
    );
  });

  it("MissingOperationError names the tool, method and path", () => {
    const err = new MissingOperationError("hermes_get_widget", "get", "/api/v1/widgets/{id}");
    expect(err.message).toContain("hermes_get_widget");
    expect(err.message).toContain("GET");
    expect(err.message).toContain("/api/v1/widgets/{id}");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/errors.test.ts`
Expected: FAIL — `src/errors.ts` does not exist yet.

- [ ] **Step 3: Create `src/errors.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { Logger } from "./logging.js";

export class HermesUnauthenticatedError extends Error {
  constructor(readonly path: string) {
    super(`Hermes rejected the request as unauthenticated: ${path}`);
    this.name = "HermesUnauthenticatedError";
  }
}

export class HermesForbiddenError extends Error {
  constructor(readonly path: string) {
    super(`Hermes rejected the request as forbidden: ${path}`);
    this.name = "HermesForbiddenError";
  }
}

export class HermesNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Not found: ${path}`);
    this.name = "HermesNotFoundError";
  }
}

export class HermesRejectedError extends Error {
  constructor(readonly path: string, readonly status: number, readonly body: string) {
    super(`Hermes rejected the request to ${path} (${status}): ${body}`);
    this.name = "HermesRejectedError";
  }
}

export class HermesUnavailableError extends Error {
  constructor(readonly path: string, readonly cause: unknown) {
    super(`Hermes is unreachable calling ${path}: ${errorMessage(cause)}`);
    this.name = "HermesUnavailableError";
  }
}

export class MissingCredentialsError extends Error {
  constructor() {
    super("This tool call has no Hermes credentials. Set HERMES_ACCESS_TOKEN and HERMES_STORE_ID.");
    this.name = "MissingCredentialsError";
  }
}

export class MissingOperationError extends Error {
  constructor(readonly toolName: string, readonly method: string, readonly pathTemplate: string) {
    super(`${toolName}: ${method.toUpperCase()} ${pathTemplate} is not present in the OpenAPI spec`);
    this.name = "MissingOperationError";
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ToolResult {
  content: [{ type: "text"; text: string }];
  isError: true;
}

const KNOWN_ERROR_CODES: [new (...args: never[]) => Error, string][] = [
  [HermesUnauthenticatedError, "UNAUTHENTICATED"],
  [HermesForbiddenError, "FORBIDDEN"],
  [HermesNotFoundError, "NOT_FOUND"],
  [HermesRejectedError, "REJECTED"],
  [HermesUnavailableError, "UNAVAILABLE"],
  [MissingCredentialsError, "MISSING_CREDENTIALS"],
];

/**
 * A known HermesError (or a missing-credentials/missing-operation error) is a
 * legitimate answer the caller needs to see, so it is surfaced with real detail.
 * Anything else is treated as an unexpected internal fault: logged in full, but
 * hidden from the caller behind a correlation id.
 */
export const toToolResult = (error: unknown, logger: Logger, tool: string): ToolResult => {
  for (const [ctor, code] of KNOWN_ERROR_CODES) {
    if (error instanceof ctor) {
      logger.warn("tool call rejected", { tool, code, error: errorMessage(error) });
      return { content: [{ type: "text", text: `[${code}] ${errorMessage(error)}` }], isError: true };
    }
  }

  const requestId = randomBytes(4).toString("hex");
  logger.error("tool call failed unexpectedly", {
    tool,
    requestId,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
  return {
    content: [
      { type: "text", text: `The tool failed unexpectedly. Reference ${requestId} in the server logs.` },
    ],
    isError: true,
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/errors.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: add typed Hermes errors and tool-result mapping"
```

---

### Task 4: HermesClient

**Files:**
- Create: `src/hermesClient.ts`
- Test: `test/hermesClient.test.ts`

**Interfaces:**
- Consumes: `HermesUnauthenticatedError`, `HermesForbiddenError`, `HermesNotFoundError`, `HermesRejectedError`, `HermesUnavailableError` from `src/errors.ts` (Task 3)
- Produces: `export interface Credentials { accessToken: string; storeId: string }`
- Produces: `export interface RequestOptions { query?: Record<string, string>; body?: unknown }`
- Produces: `export interface HermesRequester { request(method: string, path: string, options?: RequestOptions): Promise<unknown> }`
- Produces: `export class HermesClient implements HermesRequester { constructor(baseUrl: string, credentials: Credentials, timeoutMs?: number) }`

- [ ] **Step 1: Write the failing tests**

Create `test/hermesClient.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesClient } from "../src/hermesClient.js";
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
} from "../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const credentials = { accessToken: "test-token", storeId: "store-1" };

describe("HermesClient", () => {
  it("sends the credential headers and unwraps the {data} envelope", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/themes/active");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["X-Store-Id"]).toBe("store-1");
      return new Response(JSON.stringify({ data: { id: "t1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", credentials);
    const result = await client.request("GET", "/api/v1/themes/active");

    expect(result).toEqual({ id: "t1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("appends query params and sends a JSON body when provided", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/widgets/w1?display=true");
      expect(init.body).toBe(JSON.stringify({ display: true }));
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return new Response(JSON.stringify({ data: { id: "w1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", credentials);
    await client.request("PUT", "/api/v1/widgets/w1", {
      query: { display: "true" },
      body: { display: true },
    });
  });

  it("returns the raw payload when there is no {data} envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ id: "1" }]), { status: 200 }))
    );
    const client = new HermesClient("https://hermes.test", credentials);
    expect(await client.request("GET", "/x")).toEqual([{ id: "1" }]);
  });

  it("returns null for a 204 and for an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 204 })));
    const client = new HermesClient("https://hermes.test", credentials);
    expect(await client.request("DELETE", "/x")).toBeNull();
  });

  it("maps 401/403/404/4xx/5xx to their typed errors", async () => {
    const client = new HermesClient("https://hermes.test", credentials);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnauthenticatedError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesForbiddenError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesNotFoundError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad payload", { status: 422 })));
    await expect(client.request("POST", "/x")).rejects.toThrow(HermesRejectedError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnavailableError);
  });

  it("maps a network failure to HermesUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const client = new HermesClient("https://hermes.test", credentials);
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnavailableError);
  });

  it("never puts the access token in a thrown error's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const client = new HermesClient("https://hermes.test", credentials);
    try {
      await client.request("GET", "/api/v1/themes/active");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/hermesClient.test.ts`
Expected: FAIL — `src/hermesClient.ts` does not exist yet.

- [ ] **Step 3: Create `src/hermesClient.ts`**

```ts
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
} from "./errors.js";

export interface Credentials {
  accessToken: string;
  storeId: string;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
}

export interface HermesRequester {
  request(method: string, path: string, options?: RequestOptions): Promise<unknown>;
}

export class HermesClient implements HermesRequester {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: Credentials,
    private readonly timeoutMs = 20_000
  ) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          "X-Store-Id": this.credentials.storeId,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new HermesUnavailableError(path, err);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) throw new HermesUnauthenticatedError(path);
    if (response.status === 403) throw new HermesForbiddenError(path);
    if (response.status === 404) throw new HermesNotFoundError(path);
    if (response.status >= 500) {
      throw new HermesUnavailableError(path, new Error(`Hermes returned ${response.status}`));
    }
    if (response.status >= 400) {
      throw new HermesRejectedError(path, response.status, await response.text());
    }
    if (response.status === 204) return null;

    const text = await response.text();
    if (!text) return null;
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === "object" && "data" in payload) {
      return (payload as { data: unknown }).data;
    }
    return payload;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/hermesClient.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hermesClient.ts test/hermesClient.test.ts
git commit -m "feat: add HermesClient with typed error mapping"
```

---

### Task 5: OpenAPI schema resolver

**Files:**
- Create: `src/registry/schemaFromOpenApi.ts`
- Test: `test/registry/schemaFromOpenApi.test.ts`

**Interfaces:**
- Consumes: `MissingOperationError` from `src/errors.ts` (Task 3)
- Produces: `export interface OpenApiParameter { name: string; in: "path" | "query" | "header" | "cookie"; required?: boolean; description?: string; schema?: { type?: string; enum?: string[] } }`
- Produces: `export interface OpenApiOperation { parameters?: OpenApiParameter[]; requestBody?: unknown }`
- Produces: `export interface OpenApiPathItem { get?: OpenApiOperation; post?: OpenApiOperation; put?: OpenApiOperation; delete?: OpenApiOperation; patch?: OpenApiOperation }`
- Produces: `export interface OpenApiDocument { paths: Record<string, OpenApiPathItem> }`
- Produces: `export type HttpMethod = "get" | "post" | "put" | "delete"`
- Produces: `export interface EndpointDef { toolName: string; method: HttpMethod; pathTemplate: string; description: string; hasBody: boolean; bodyDescription?: string }`
- Produces: `export interface CompiledEndpoint extends EndpointDef { inputSchema: import("zod").ZodObject<Record<string, import("zod").ZodTypeAny>>; paramLocations: Record<string, "path" | "query"> }`
- Produces: `export const compileEndpoint: (doc: OpenApiDocument, entry: EndpointDef) => CompiledEndpoint`

- [ ] **Step 1: Write the failing tests**

Create `test/registry/schemaFromOpenApi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  compileEndpoint,
  type EndpointDef,
  type OpenApiDocument,
} from "../../src/registry/schemaFromOpenApi.js";
import { MissingOperationError } from "../../src/errors.js";

const fixtureDoc: OpenApiDocument = {
  paths: {
    "/api/v1/widgets/{id}": {
      get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
      put: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {},
      },
    },
    "/api/v1/stores/{storeId}/custom-blocks": {
      get: {
        parameters: [
          { name: "storeId", in: "path", required: true, schema: { type: "string" } },
          { name: "page", in: "query", required: true, schema: { type: "integer" } },
          {
            name: "contentType",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["HTML", "URL"] },
          },
        ],
      },
    },
  },
};

describe("compileEndpoint", () => {
  it("builds required path params and marks their location", () => {
    const entry: EndpointDef = {
      toolName: "hermes_get_widget",
      method: "get",
      pathTemplate: "/api/v1/widgets/{id}",
      description: "Get a widget.",
      hasBody: false,
    };
    const compiled = compileEndpoint(fixtureDoc, entry);
    expect(compiled.paramLocations).toEqual({ id: "path" });
    expect(compiled.inputSchema.safeParse({ id: "w1" }).success).toBe(true);
    expect(compiled.inputSchema.safeParse({}).success).toBe(false);
  });

  it("adds a passthrough body field when hasBody is true", () => {
    const entry: EndpointDef = {
      toolName: "hermes_update_widget",
      method: "put",
      pathTemplate: "/api/v1/widgets/{id}",
      description: "Update a widget.",
      hasBody: true,
    };
    const compiled = compileEndpoint(fixtureDoc, entry);
    expect(compiled.inputSchema.safeParse({ id: "w1", body: { display: true } }).success).toBe(true);
  });

  it("makes an optional enum query param optional and constrained, a required integer required", () => {
    const entry: EndpointDef = {
      toolName: "hermes_list_custom_blocks",
      method: "get",
      pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
      description: "List custom blocks.",
      hasBody: false,
    };
    const compiled = compileEndpoint(fixtureDoc, entry);
    expect(compiled.paramLocations).toEqual({ storeId: "path", page: "query", contentType: "query" });
    expect(compiled.inputSchema.safeParse({ storeId: "s1", page: 1 }).success).toBe(true);
    expect(compiled.inputSchema.safeParse({ storeId: "s1" }).success).toBe(false);
    expect(
      compiled.inputSchema.safeParse({ storeId: "s1", page: 1, contentType: "BOGUS" }).success
    ).toBe(false);
  });

  it("throws MissingOperationError when the method is absent on an existing path", () => {
    const entry: EndpointDef = {
      toolName: "hermes_delete_widget",
      method: "delete",
      pathTemplate: "/api/v1/widgets/{id}",
      description: "Delete a widget.",
      hasBody: false,
    };
    expect(() => compileEndpoint(fixtureDoc, entry)).toThrow(MissingOperationError);
  });

  it("throws MissingOperationError when the path is absent entirely", () => {
    const entry: EndpointDef = {
      toolName: "hermes_get_theme",
      method: "get",
      pathTemplate: "/api/v1/themes/{id}",
      description: "Get a theme.",
      hasBody: false,
    };
    expect(() => compileEndpoint(fixtureDoc, entry)).toThrow(MissingOperationError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/registry/schemaFromOpenApi.test.ts`
Expected: FAIL — `src/registry/schemaFromOpenApi.ts` does not exist yet.

- [ ] **Step 3: Create `src/registry/schemaFromOpenApi.ts`**

```ts
import * as z from "zod";
import { MissingOperationError } from "../errors.js";

export interface OpenApiParameterSchema {
  type?: string;
  enum?: string[];
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiParameterSchema;
}

export interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: unknown;
}

export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
  patch?: OpenApiOperation;
}

export interface OpenApiDocument {
  paths: Record<string, OpenApiPathItem>;
}

export type HttpMethod = "get" | "post" | "put" | "delete";

export interface EndpointDef {
  toolName: string;
  method: HttpMethod;
  pathTemplate: string;
  description: string;
  hasBody: boolean;
  bodyDescription?: string;
}

export interface CompiledEndpoint extends EndpointDef {
  inputSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  paramLocations: Record<string, "path" | "query">;
}

const paramSchemaToZod = (schema: OpenApiParameterSchema | undefined): z.ZodTypeAny => {
  if (schema?.enum && schema.enum.length > 0) {
    const [first, ...rest] = schema.enum;
    return z.enum([first, ...rest]);
  }
  if (schema?.type === "integer" || schema?.type === "number") return z.coerce.number();
  if (schema?.type === "boolean") return z.coerce.boolean();
  return z.string();
};

export const compileEndpoint = (doc: OpenApiDocument, entry: EndpointDef): CompiledEndpoint => {
  const operation = doc.paths[entry.pathTemplate]?.[entry.method];
  if (!operation) {
    throw new MissingOperationError(entry.toolName, entry.method, entry.pathTemplate);
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const paramLocations: Record<string, "path" | "query"> = {};

  for (const param of operation.parameters ?? []) {
    if (param.in !== "path" && param.in !== "query") continue;
    let field = paramSchemaToZod(param.schema).describe(param.description ?? param.name);
    if (!param.required) field = field.optional();
    shape[param.name] = field;
    paramLocations[param.name] = param.in;
  }

  if (entry.hasBody) {
    shape.body = z
      .record(z.string(), z.unknown())
      .describe(
        entry.bodyDescription ?? "Request body. Hermes validates its shape; this tool does not re-validate it."
      );
  }

  return { ...entry, inputSchema: z.object(shape), paramLocations };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/registry/schemaFromOpenApi.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/schemaFromOpenApi.ts test/registry/schemaFromOpenApi.test.ts
git commit -m "feat: add OpenAPI-to-Zod schema resolver"
```

---

### Task 6: Endpoint allowlist, snapshot loader, SchemaRegistry

**Files:**
- Create: `openapi/hermes-api-docs.json` (already copied into the repo working tree from `/tmp/hermes-api-docs.json` before this plan was written — verify it is present, do not re-fetch)
- Create: `src/registry/endpoints.ts`
- Create: `src/registry/snapshot.ts`
- Create: `src/registry/schemaRegistry.ts`
- Test: `test/registry/snapshot.test.ts`
- Test: `test/registry/schemaRegistry.test.ts`

**Interfaces:**
- Consumes: `EndpointDef`, `CompiledEndpoint`, `OpenApiDocument`, `compileEndpoint` from `src/registry/schemaFromOpenApi.ts` (Task 5)
- Consumes: `Logger` from `src/logging.ts` (Task 2), `errorMessage` from `src/errors.ts` (Task 3)
- Produces: `export const ENDPOINTS: EndpointDef[]` (11 entries)
- Produces: `export const loadSnapshotDoc: () => OpenApiDocument`
- Produces: `export class SchemaRegistry { static fromDocument(doc: OpenApiDocument): SchemaRegistry; get(toolName: string): CompiledEndpoint; list(): CompiledEndpoint[]; refresh(doc: OpenApiDocument, logger: Logger): void }`

- [ ] **Step 1: Verify the OpenAPI snapshot is present**

Run: `node -e "const d=require('./openapi/hermes-api-docs.json'); console.log(Object.keys(d.paths).length)"`
Expected: prints `272`. If the file is missing, copy it from `/tmp/hermes-api-docs.json` (fetched earlier from `https://hermes-atlas.vajro.com/v3/api-docs`) to `openapi/hermes-api-docs.json` before continuing.

- [ ] **Step 2: Create `src/registry/endpoints.ts`**

```ts
import type { EndpointDef } from "./schemaFromOpenApi.js";

export const ENDPOINTS: EndpointDef[] = [
  {
    toolName: "hermes_get_active_theme",
    method: "get",
    pathTemplate: "/api/v1/themes/active",
    description: "Get the store's currently active theme.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_theme",
    method: "get",
    pathTemplate: "/api/v1/themes/{id}",
    description: "Get one theme by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_theme_versions",
    method: "get",
    pathTemplate: "/api/v1/themes/{themeId}/versions",
    description: "List saved versions of a theme.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_pages",
    method: "get",
    pathTemplate: "/api/v1/themes/{id}/pages",
    description: "List the pages that belong to a theme.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_page",
    method: "get",
    pathTemplate: "/api/v1/pages/{id}",
    description: "Get one page by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_custom_blocks",
    method: "get",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
    description:
      "List a store's custom blocks, optionally filtered by type, content type, segregation type or search term.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_custom_block",
    method: "get",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks/{id}",
    description: "Get one custom block by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_create_custom_block",
    method: "post",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
    description: "Create a new custom block.",
    hasBody: true,
    bodyDescription:
      "Mirrors Hermes's CreateCustomBlockDto: name, type, contentType, segregationType and content are required; collapseType and config are optional.",
  },
  {
    toolName: "hermes_update_custom_block",
    method: "put",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks/{id}",
    description: "Update an existing custom block.",
    hasBody: true,
    bodyDescription:
      "Mirrors Hermes's UpdateCustomBlockDto: name, type, contentType, segregationType and content are required; collapseType and config are optional.",
  },
  {
    toolName: "hermes_get_widget",
    method: "get",
    pathTemplate: "/api/v1/widgets/{id}",
    description: "Get one widget by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_update_widget",
    method: "put",
    pathTemplate: "/api/v1/widgets/{id}",
    description: "Update a widget.",
    hasBody: true,
    bodyDescription:
      "Mirrors Hermes's UpdateWidgetDto: display is required; config, translations and name are optional.",
  },
];
```

- [ ] **Step 3: Create `src/registry/snapshot.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OpenApiDocument } from "./schemaFromOpenApi.js";

/**
 * Walks up from `startDir` to the nearest ancestor containing a `package.json`.
 * Needed because esbuild bundles this module into a single file at `dist/`,
 * which sits one level shallower than `src/registry/` — a fixed `../..` would
 * be correct unbundled and wrong bundled. Walking to the package root works
 * at both depths.
 */
const findRepoRoot = (startDir: string): string => {
  let dir = startDir;
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find package.json above ${startDir}`);
    }
    dir = parent;
  }
  return dir;
};

export const loadSnapshotDoc = (): OpenApiDocument => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const snapshotPath = path.join(findRepoRoot(here), "openapi", "hermes-api-docs.json");
  return JSON.parse(readFileSync(snapshotPath, "utf-8")) as OpenApiDocument;
};
```

- [ ] **Step 4: Write the failing test for the snapshot loader**

Create `test/registry/snapshot.test.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/registry/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing tests for SchemaRegistry**

Create `test/registry/schemaRegistry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { ENDPOINTS } from "../../src/registry/endpoints.js";
import { createLogger } from "../../src/logging.js";

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
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run test/registry/schemaRegistry.test.ts`
Expected: FAIL — `src/registry/schemaRegistry.ts` does not exist yet.

- [ ] **Step 8: Create `src/registry/schemaRegistry.ts`**

```ts
import type { Logger } from "../logging.js";
import { errorMessage } from "../errors.js";
import { compileEndpoint, type CompiledEndpoint, type OpenApiDocument } from "./schemaFromOpenApi.js";
import { ENDPOINTS } from "./endpoints.js";

export class SchemaRegistry {
  private compiled: Map<string, CompiledEndpoint>;

  private constructor(compiled: Map<string, CompiledEndpoint>) {
    this.compiled = compiled;
  }

  /**
   * Compiles every allowlisted entry against `doc`, throwing if any entry
   * fails. Used only at startup against the checked-in snapshot, which must
   * always compile cleanly — a failure here is a bug in this repo's own
   * allowlist, not a transient issue, so it should fail loudly.
   */
  static fromDocument(doc: OpenApiDocument): SchemaRegistry {
    const compiled = new Map<string, CompiledEndpoint>();
    for (const entry of ENDPOINTS) {
      compiled.set(entry.toolName, compileEndpoint(doc, entry));
    }
    return new SchemaRegistry(compiled);
  }

  get(toolName: string): CompiledEndpoint {
    const entry = this.compiled.get(toolName);
    if (!entry) throw new Error(`No compiled schema registered for tool "${toolName}"`);
    return entry;
  }

  list(): CompiledEndpoint[] {
    return [...this.compiled.values()];
  }

  /**
   * Recompiles every allowlisted entry against a freshly fetched `doc`. A
   * single entry's failure is logged and that entry keeps its last-known-good
   * schema; the rest still refresh — a removed or changed operation degrades
   * one tool, not the whole server.
   */
  refresh(doc: OpenApiDocument, logger: Logger): void {
    for (const entry of ENDPOINTS) {
      try {
        this.compiled.set(entry.toolName, compileEndpoint(doc, entry));
      } catch (err) {
        logger.error("openapi schema refresh failed for tool, keeping last-known-good", {
          tool: entry.toolName,
          error: errorMessage(err),
        });
      }
    }
  }
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run test/registry/schemaRegistry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Commit**

```bash
git add openapi/hermes-api-docs.json src/registry/endpoints.ts src/registry/snapshot.ts src/registry/schemaRegistry.ts test/registry/snapshot.test.ts test/registry/schemaRegistry.test.ts
git commit -m "feat: add the 11-tool Hermes endpoint allowlist and SchemaRegistry"
```

---

### Task 7: OpenAPI live sync

**Files:**
- Create: `src/openapiSync.ts`
- Test: `test/openapiSync.test.ts`

**Interfaces:**
- Consumes: `OpenApiDocument` from `src/registry/schemaFromOpenApi.ts` (Task 5), `SchemaRegistry` from `src/registry/schemaRegistry.ts` (Task 6), `Logger` from `src/logging.ts` (Task 2), `errorMessage` from `src/errors.ts` (Task 3)
- Produces: `export const fetchOpenApiDoc: (url: string, timeoutMs: number) => Promise<OpenApiDocument>`
- Produces: `export interface RefreshLoopConfig { openApiDocsUrl: string; openApiFetchTimeoutMs: number; openApiRefreshIntervalS: number }`
- Produces: `export const startOpenApiRefreshLoop: (registry: SchemaRegistry, config: RefreshLoopConfig, logger: Logger) => () => void`

- [ ] **Step 1: Write the failing tests**

Create `test/openapiSync.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/openapiSync.test.ts`
Expected: FAIL — `src/openapiSync.ts` does not exist yet.

- [ ] **Step 3: Create `src/openapiSync.ts`**

```ts
import type { Logger } from "./logging.js";
import { errorMessage } from "./errors.js";
import type { OpenApiDocument } from "./registry/schemaFromOpenApi.js";
import type { SchemaRegistry } from "./registry/schemaRegistry.js";

export const fetchOpenApiDoc = async (url: string, timeoutMs: number): Promise<OpenApiDocument> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`OpenAPI doc fetch failed with status ${response.status}`);
    }
    return (await response.json()) as OpenApiDocument;
  } finally {
    clearTimeout(timer);
  }
};

export interface RefreshLoopConfig {
  openApiDocsUrl: string;
  openApiFetchTimeoutMs: number;
  openApiRefreshIntervalS: number;
}

/**
 * Fires an immediate refresh, then one every `openApiRefreshIntervalS`. Never
 * throws: a failed fetch is logged and the registry keeps its current
 * schemas. This single loop covers both the spec's "startup fallback" and
 * "steady-state fallback" cases — startup is simply the loop's first tick,
 * fired synchronously rather than waiting for the interval.
 */
export const startOpenApiRefreshLoop = (
  registry: SchemaRegistry,
  config: RefreshLoopConfig,
  logger: Logger
): (() => void) => {
  const refreshOnce = (): void => {
    fetchOpenApiDoc(config.openApiDocsUrl, config.openApiFetchTimeoutMs)
      .then((doc) => {
        registry.refresh(doc, logger);
        logger.info("openapi schema refresh ok");
      })
      .catch((err) => {
        logger.warn("openapi schema refresh failed, keeping last-known-good schemas", {
          error: errorMessage(err),
        });
      });
  };

  refreshOnce();
  const timer = setInterval(refreshOnce, config.openApiRefreshIntervalS * 1000);
  timer.unref();
  return () => clearInterval(timer);
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/openapiSync.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/openapiSync.ts test/openapiSync.test.ts
git commit -m "feat: fetch the live OpenAPI doc at startup and on an interval"
```

---

### Task 8: Tool registration

**Files:**
- Create: `src/tools/index.ts`
- Test: `test/tools/index.test.ts`

**Interfaces:**
- Consumes: `HermesMcpConfig` from `src/config.ts` (Task 1), `Logger` from `src/logging.ts` (Task 2), `MissingCredentialsError`, `toToolResult`, `ToolResult` from `src/errors.ts` (Task 3), `Credentials`, `HermesRequester` from `src/hermesClient.ts` (Task 4), `CompiledEndpoint` from `src/registry/schemaFromOpenApi.ts` (Task 5), `ENDPOINTS` from `src/registry/endpoints.ts`, `SchemaRegistry` from `src/registry/schemaRegistry.ts` (Task 6)
- Produces: `export interface ToolContext { config: HermesMcpConfig; logger: Logger; credentials: Credentials | null; registry: SchemaRegistry; createClient: (credentials: Credentials) => HermesRequester }`
- Produces: `export const registerHermesTools: (server: import("@modelcontextprotocol/server").McpServer, ctx: ToolContext) => void`

- [ ] **Step 1: Write the failing tests**

Create `test/tools/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { createLogger } from "../../src/logging.js";
import { loadConfig } from "../../src/config.js";
import type { HermesRequester } from "../../src/hermesClient.js";

const buildServerAndClient = async (ctx: ToolContext): Promise<Client> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHermesTools(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const baseCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  config: loadConfig({}),
  logger: createLogger({ logLevel: "silent" }),
  credentials: { accessToken: "t", storeId: "s1" },
  registry: SchemaRegistry.fromDocument(loadSnapshotDoc()),
  createClient: () => ({ request: vi.fn() }) as HermesRequester,
  ...overrides,
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("registerHermesTools", () => {
  it("registers all eleven hermes_ tools", async () => {
    const client = await buildServerAndClient(baseCtx());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "hermes_create_custom_block",
        "hermes_get_active_theme",
        "hermes_get_custom_block",
        "hermes_get_page",
        "hermes_get_theme",
        "hermes_get_widget",
        "hermes_list_custom_blocks",
        "hermes_list_pages",
        "hermes_list_theme_versions",
        "hermes_update_custom_block",
        "hermes_update_widget",
      ].sort()
    );
  });

  it("calls the injected client with the substituted path and returns its result as text", async () => {
    const request = vi.fn(async () => ({ id: "w1", display: true }));
    const ctx = baseCtx({ createClient: () => ({ request }) });
    const client = await buildServerAndClient(ctx);

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/widgets/w1", { query: {}, body: undefined });
    expect(JSON.parse(textOf(result))).toEqual({ id: "w1", display: true });
  });

  it("returns MISSING_CREDENTIALS and never calls Hermes when credentials are absent", async () => {
    const request = vi.fn();
    const ctx = baseCtx({ credentials: null, createClient: () => ({ request }) });
    const client = await buildServerAndClient(ctx);

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(request).not.toHaveBeenCalled();
  });

  it("separates path params from query params for hermes_list_custom_blocks", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const ctx = baseCtx({ createClient: () => ({ request }) });
    const client = await buildServerAndClient(ctx);

    await client.callTool({
      name: "hermes_list_custom_blocks",
      arguments: { storeId: "s1", page: 1, contentType: "HTML" },
    });

    expect(request).toHaveBeenCalledWith("get", "/api/v1/stores/s1/custom-blocks", {
      query: { page: "1", contentType: "HTML" },
      body: undefined,
    });
  });

  it("passes the body field through for a create/update tool", async () => {
    const request = vi.fn(async () => ({ id: "cb1" }));
    const ctx = baseCtx({ createClient: () => ({ request }) });
    const client = await buildServerAndClient(ctx);

    await client.callTool({
      name: "hermes_create_custom_block",
      arguments: {
        storeId: "s1",
        body: { name: "n", type: "FULLSCREEN", contentType: "HTML", segregationType: "HOME", content: "<div></div>" },
      },
    });

    expect(request).toHaveBeenCalledWith("post", "/api/v1/stores/s1/custom-blocks", {
      query: {},
      body: { name: "n", type: "FULLSCREEN", contentType: "HTML", segregationType: "HOME", content: "<div></div>" },
    });
  });

  it("surfaces a rejected Hermes call as a visible, coded error", async () => {
    const { HermesNotFoundError } = await import("../../src/errors.js");
    const request = vi.fn(async () => {
      throw new HermesNotFoundError("/api/v1/widgets/missing");
    });
    const ctx = baseCtx({ createClient: () => ({ request }) });
    const client = await buildServerAndClient(ctx);

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "missing" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/index.test.ts`
Expected: FAIL — `src/tools/index.ts` does not exist yet.

- [ ] **Step 3: Create `src/tools/index.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "../logging.js";
import type { HermesMcpConfig } from "../config.js";
import type { SchemaRegistry } from "../registry/schemaRegistry.js";
import type { CompiledEndpoint } from "../registry/schemaFromOpenApi.js";
import { ENDPOINTS } from "../registry/endpoints.js";
import type { Credentials, HermesRequester } from "../hermesClient.js";
import { MissingCredentialsError, toToolResult, type ToolResult } from "../errors.js";

export interface ToolContext {
  config: HermesMcpConfig;
  logger: Logger;
  credentials: Credentials | null;
  registry: SchemaRegistry;
  createClient: (credentials: Credentials) => HermesRequester;
}

interface BuiltRequest {
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

const buildRequest = (compiled: CompiledEndpoint, args: Record<string, unknown>): BuiltRequest => {
  let path = compiled.pathTemplate;
  const query: Record<string, string> = {};
  for (const [name, location] of Object.entries(compiled.paramLocations)) {
    const value = args[name];
    if (value === undefined) continue;
    if (location === "path") {
      path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    } else {
      query[name] = String(value);
    }
  }
  return { path, query, body: compiled.hasBody ? args.body : undefined };
};

type ToolReturn = ToolResult | { content: [{ type: "text"; text: string }] };

const wrap =
  (toolName: string, method: string, ctx: ToolContext) =>
  async (args: Record<string, unknown>): Promise<ToolReturn> => {
    const start = Date.now();
    try {
      if (!ctx.credentials) {
        throw new MissingCredentialsError();
      }
      const compiled = ctx.registry.get(toolName);
      const { path, query, body } = buildRequest(compiled, args);
      const client = ctx.createClient(ctx.credentials);
      const data = await client.request(method, path, { query, body });
      ctx.logger.info("tool call ok", { tool: toolName, durationMs: Date.now() - start });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return toToolResult(err, ctx.logger, toolName);
    }
  };

export const registerHermesTools = (server: McpServer, ctx: ToolContext): void => {
  for (const definition of ENDPOINTS) {
    const compiled = ctx.registry.get(definition.toolName);
    server.registerTool(
      definition.toolName,
      { description: definition.description, inputSchema: compiled.inputSchema },
      wrap(definition.toolName, definition.method, ctx) as Parameters<typeof server.registerTool>[2]
    );
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/index.test.ts`
Expected: PASS (6 tests). If TypeScript flags the `as Parameters<typeof server.registerTool>[2]` cast or the `inputSchema: compiled.inputSchema` assignment, tighten the cast rather than switching to `any` — the runtime behavior (a `z.ZodObject` used as `inputSchema`) is confirmed correct against the installed `@modelcontextprotocol/server` types; this is a known friction point of registering tools from a runtime array instead of one call per tool with a literal schema.

- [ ] **Step 5: Run the full test suite so far**

Run: `npx vitest run`
Expected: PASS, all prior tasks' tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts test/tools/index.test.ts
git commit -m "feat: register the 11 Hermes tools with credential and error handling"
```

---

### Task 9: Server entrypoint + integration test

**Files:**
- Create: `src/server.ts`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `HermesMcpConfig` from `src/config.ts` (Task 1); `createLogger`, `Logger` from `src/logging.ts` (Task 2); `registerHermesTools` from `src/tools/index.ts` (Task 8); `SchemaRegistry` from `src/registry/schemaRegistry.ts` (Task 6); `loadSnapshotDoc` from `src/registry/snapshot.ts` (Task 6); `startOpenApiRefreshLoop` from `src/openapiSync.ts` (Task 7); `HermesClient` from `src/hermesClient.ts` (Task 4); `ENDPOINTS` from `src/registry/endpoints.ts` (Task 6)
- Produces: `export const createServer: (config?: HermesMcpConfig, logger?: Logger) => import("@modelcontextprotocol/server").McpServer`

- [ ] **Step 1: Create `src/server.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, type HermesMcpConfig } from "./config.js";
import { createLogger, type Logger } from "./logging.js";
import { registerHermesTools } from "./tools/index.js";
import { SchemaRegistry } from "./registry/schemaRegistry.js";
import { loadSnapshotDoc } from "./registry/snapshot.js";
import { startOpenApiRefreshLoop } from "./openapiSync.js";
import { HermesClient } from "./hermesClient.js";
import { ENDPOINTS } from "./registry/endpoints.js";

/**
 * Builds a fully configured server without connecting it to a transport.
 * Kept separate from stdio setup so tests can drive a real server over
 * InMemoryTransport, matching vajro-custom-blocks-sdk/mcp's own pattern.
 */
export const createServer = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config)
): McpServer => {
  const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
  startOpenApiRefreshLoop(registry, config, logger);

  const server = new McpServer({ name: config.serverName, version: config.serverVersion });
  registerHermesTools(server, {
    config,
    logger,
    credentials: config.credentials,
    registry,
    createClient: (credentials) => new HermesClient(config.hermesBaseUrl, credentials),
  });

  logger.info("server ready", { tools: ENDPOINTS.length });
  return server;
};

/* c8 ignore start — process entry point, covered by running the binary */
if (process.argv[1]?.endsWith("server.js")) {
  serveStdio(() => createServer());
}
/* c8 ignore stop */
```

- [ ] **Step 2: Write the integration test**

Create `test/integration.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { createLogger } from "../src/logging.js";
import { loadConfig } from "../src/config.js";
import { ENDPOINTS } from "../src/registry/endpoints.js";

let client: Client;

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ paths: {} }), { status: 200 }))
  );
  const config = loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" });
  const server = createServer(config, createLogger(config, () => {}));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "integration-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools/list", () => {
  it("advertises every allowlisted tool with a description and input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ENDPOINTS.map((e) => e.toolName).sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(5);
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });
});

describe("credentials", () => {
  it("rejects a tool call with MISSING_CREDENTIALS when no HERMES_ACCESS_TOKEN/HERMES_STORE_ID were configured", async () => {
    const result = await client.callTool({ name: "hermes_get_active_theme", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("MISSING_CREDENTIALS");
  });
});

describe("a successful tool call end-to-end with mocked Hermes", () => {
  it("calls hermes_get_active_theme through the real HermesClient and unwraps {data}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/v3/api-docs")) {
          return new Response(JSON.stringify({ paths: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { id: "theme-1" } }), { status: 200 });
      })
    );
    const config = loadConfig({
      HERMES_MCP_LOG_LEVEL: "silent",
      HERMES_ACCESS_TOKEN: "test-token",
      HERMES_STORE_ID: "store-1",
    });
    const server = createServer(config, createLogger(config, () => {}));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const authedClient = new Client({ name: "authed-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), authedClient.connect(clientTransport)]);

    const result = await authedClient.callTool({ name: "hermes_get_active_theme", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ id: "theme-1" });
  });
});

describe("stdout discipline", () => {
  it("has no console.log or process.stdout.write anywhere under src/", () => {
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("src", f));
    const offenders = files.filter((f) =>
      /console\.log|process\.stdout/.test(stripComments(readFileSync(f, "utf8")))
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS (4 tests). If `createServer`'s call to `startOpenApiRefreshLoop` races the mocked-fetch setup in a given test, confirm `vi.stubGlobal("fetch", ...)` runs before `createServer(...)` in that test (it does, in every case above) — the refresh loop's first fetch fires synchronously inside `createServer`.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, every test file from every task green.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/integration.test.ts
git commit -m "feat: add stdio server entrypoint and end-to-end integration test"
```

---

### Task 10: Build script, README, and Claude Code registration

**Files:**
- Create: `scripts/build.mjs`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing new — wires up the build for `src/server.ts` (Task 9)
- Produces: `dist/server.js` (build artifact, gitignored, not committed)

- [ ] **Step 1: Create `scripts/build.mjs`**

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/server.js",
  external: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio", "zod"],
  logLevel: "info",
});
```

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: creates `dist/server.js`, no errors. The `#!/usr/bin/env node` shebang from `src/server.ts` should be the first line of the output (esbuild preserves it automatically).

- [ ] **Step 3: Smoke-test the built server starts cleanly over stdio**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/server.js`
Expected: a single JSON-RPC response on stdout listing the 11 `hermes_*` tools, with any startup log lines appearing on stderr, not mixed into the stdout JSON.

- [ ] **Step 4: Create `README.md`**

```markdown
# hermes-mcp

A stdio MCP server exposing a curated set of Hermes Atlas REST endpoints as
tools. Design rationale lives in
[`docs/superpowers/specs/2026-09-08-hermes-mcp-design.md`](docs/superpowers/specs/2026-09-08-hermes-mcp-design.md).

## Run it

\`\`\`bash
npm install
npm run build        # esbuild -> dist/server.js
npm start             # node dist/server.js -- speaks MCP over stdio
\`\`\`

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HERMES_MCP_LOG_LEVEL` | `info` | `silent`\|`error`\|`warn`\|`info`\|`debug` |
| `HERMES_BASE_URL` | `https://hermes-atlas.vjr-dev.com` | Host root tool calls go to |
| `HERMES_OPENAPI_DOCS_URL` | `https://hermes-atlas.vajro.com/v3/api-docs` | Where tool schemas refresh from |
| `HERMES_OPENAPI_REFRESH_INTERVAL_S` | `900` | Background schema refresh interval |
| `HERMES_ACCESS_TOKEN` | — | Set together with `HERMES_STORE_ID`, or neither |
| `HERMES_STORE_ID` | — | Set together with `HERMES_ACCESS_TOKEN`, or neither |

One process serves exactly one Hermes identity for its whole life — set
credentials per process, the same way you would for any personal API token.

## Register with Claude Code

\`dist/server.js\` is a build artifact and is not committed — run
\`npm run build\` once before registering, and again after any change under
\`src/\`.

\`\`\`bash
claude mcp add hermes-mcp --scope user \\
  -e HERMES_MCP_LOG_LEVEL=info \\
  -e HERMES_ACCESS_TOKEN=<your-token> \\
  -e HERMES_STORE_ID=<your-store-id> \\
  -- node "/absolute/path/to/hermes-mcp/dist/server.js"
\`\`\`

Then verify:

\`\`\`bash
claude mcp list
claude mcp get hermes-mcp
\`\`\`

## The 11 tools

| Tool | Hermes operation |
|---|---|
| `hermes_get_active_theme` | `GET /api/v1/themes/active` |
| `hermes_get_theme` | `GET /api/v1/themes/{id}` |
| `hermes_list_theme_versions` | `GET /api/v1/themes/{themeId}/versions` |
| `hermes_list_pages` | `GET /api/v1/themes/{id}/pages` |
| `hermes_get_page` | `GET /api/v1/pages/{id}` |
| `hermes_list_custom_blocks` | `GET /api/v1/stores/{storeId}/custom-blocks` |
| `hermes_get_custom_block` | `GET /api/v1/stores/{storeId}/custom-blocks/{id}` |
| `hermes_create_custom_block` | `POST /api/v1/stores/{storeId}/custom-blocks` |
| `hermes_update_custom_block` | `PUT /api/v1/stores/{storeId}/custom-blocks/{id}` |
| `hermes_get_widget` | `GET /api/v1/widgets/{id}` |
| `hermes_update_widget` | `PUT /api/v1/widgets/{id}` |

Adding a twelfth is one entry in `src/registry/endpoints.ts` plus a run of
the test suite — `test/registry/schemaRegistry.test.ts` fails loudly if the
new entry doesn't compile against the checked-in OpenAPI snapshot.

## Tests

\`\`\`bash
npm test          # vitest run
npm run test:watch
\`\`\`

## Hard constraints

1. Never write to stdout under `src/` — stdout is the MCP transport.
2. Never store a credential outside the process it was configured for.
3. Never expose a Hermes operation that isn't a named entry in
   `src/registry/endpoints.ts`.
4. Never log a token, at any log level.
```

- [ ] **Step 5: Run the full test suite one last time**

Run: `npm test`
Expected: PASS, all tests across all ten tasks green.

- [ ] **Step 6: Commit**

```bash
git add scripts/build.mjs README.md
git commit -m "feat: add esbuild build script and README"
```

---

## Post-plan checklist (not a task — do after Task 10)

- Confirm `Superfans.code-workspace` already lists `hermes-mcp` as a folder
  (it does — added when the repo was created, before this plan was written).
- Do not register `hermes-mcp` with `claude mcp add` on the user's behalf —
  that installs a personal access token into their global Claude Code config,
  which is their call, not this plan's.
