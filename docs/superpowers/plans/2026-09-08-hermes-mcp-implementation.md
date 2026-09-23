# hermes-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `hermes-mcp`, a stdio MCP server exposing 11 curated Hermes
Atlas REST endpoints plus a schema-refresh tool, authenticated via a persisted,
auto-refreshing token obtained through a local login CLI.

**Architecture:** One TypeScript source tree (`src/`) compiled by esbuild into two
stdio-served bundles: `dist/server.js` (the MCP server) and `dist/login.js` (a
one-shot CLI that runs a short-lived local HTTP server + browser-based login
page, then exits). `src/registry/endpoints.ts` is the only place a Hermes
operation can be exposed; `src/registry/schemaFromOpenApi.ts` turns an allowlist
entry plus an OpenAPI document into a Zod schema, used both to compile the
checked-in snapshot at startup and to refresh schemas from the live spec (on an
interval, and on demand via `hermes_refresh_openapi`). `TokenManager` owns the
credential for the process's life — loaded from a `credentials.json` the login
CLI writes (env vars remain a fallback), refreshed transparently before it
expires or once on an unexpected 401. `HermesClient` itself never grows an auth
or logging responsibility — those live entirely in `wrap()`, one place, per the
project's existing observability principle.

**Tech Stack:** Node 20, TypeScript 5.7, `@modelcontextprotocol/server` v2 (stdio
transport), Zod v4, esbuild, vitest, `@modelcontextprotocol/client` v2
(test-only, for `InMemoryTransport`), `env-paths` (pure-JS OS config-dir
resolution, no native dependency).

**Spec:** `docs/superpowers/specs/2026-09-08-hermes-mcp-design.md` (base design)
and `docs/superpowers/specs/2026-09-08-hermes-mcp-auth-design.md` (auth, tracing
& refresh extension — read both; the second amends specific sections of the
first).

## Global Constraints

- Never write to stdout anywhere under `src/` — stdout is the MCP transport; the
  logger writes to stderr only.
- Never store a credential outside the process it was configured for beyond the
  one persisted `credentials.json` file, which itself lives under the OS
  user-config dir (via `env-paths`), never inside the repo.
- Never expose a Hermes operation that isn't a named entry in
  `src/registry/endpoints.ts` — no dynamic/generic path construction from caller
  input. `hermes_refresh_openapi` is not such an operation (it calls no Hermes
  business endpoint) and is registered outside that allowlist mechanism.
- Never log a token, at any log level — the logger redacts token-shaped fields as
  a second line of defence.
- `HERMES_BASE_URL` and `HERMES_OPENAPI_DOCS_URL` are separate settings on
  separate hosts/paths and must never be derived from one another.
- `HermesClient` never gains a logger or auth dependency — all observability and
  the token-refresh-and-retry policy live in `wrap()` (`src/tools/index.ts`),
  once, per the existing principle that failure mapping and logging live in one
  place.
- The login CLI's local HTTP server binds to `127.0.0.1` only, serves exactly one
  login, and is not and must never become the MCP server's transport.
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
    "hermes-mcp": "./dist/server.js",
    "hermes-mcp-login": "./dist/login.js"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "start": "node dist/server.js",
    "login": "node dist/login.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "env-paths": "^3.0.0",
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
HERMES_BASE_URL=https://hermes-atlas.vajro.com

# Where the live OpenAPI spec is fetched from, to keep tool schemas current
HERMES_OPENAPI_DOCS_URL=https://hermes-atlas.vajro.com/v3/api-docs
HERMES_OPENAPI_REFRESH_INTERVAL_S=900

# Preferred: run `npm run login` instead, which persists a token to
# credentials.json under your OS config dir. These two are only a fallback,
# used when no credentials.json exists. Set both together, or neither.
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
    expect(config.hermesBaseUrl).toBe("https://hermes-atlas.vajro.com");
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
    hermesBaseUrl: env.HERMES_BASE_URL ?? "https://hermes-atlas.vajro.com",
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
const REDACTED_KEYS = new Set(["authorization", "accesstoken", "token", "password", "refreshtoken"]);

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

  it("MissingCredentialsError names both the login command and the env var fallback", () => {
    const err = new MissingCredentialsError();
    expect(err.message).toContain("hermes-mcp-login");
    expect(err.message).toContain("HERMES_ACCESS_TOKEN");
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
    super(
      "This tool call has no valid Hermes credentials. Run `hermes-mcp-login`, or set HERMES_ACCESS_TOKEN and HERMES_STORE_ID."
    );
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
Expected: PASS (10 tests).

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

**Note:** this class stays deliberately free of any logger or token-refresh
responsibility — `wrap()` (Task 11) owns both. Do not add a `traceId` parameter
or a `Logger` here.

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
- Produces: `export interface CompiledEndpoint extends EndpointDef { inputSchema: z.ZodObject<Record<string, z.ZodTypeAny>>; paramLocations: Record<string, "path" | "query"> }`
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
- Verify present: `openapi/hermes-api-docs.json` (already committed to the repo — do not re-fetch)
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
Expected: prints `272`.

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

- [ ] **Step 4: Write the test for the snapshot loader**

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
git add src/registry/endpoints.ts src/registry/snapshot.ts src/registry/schemaRegistry.ts test/registry/snapshot.test.ts test/registry/schemaRegistry.test.ts
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

### Task 8: Token store (persisted credentials file)

**Files:**
- Create: `src/auth/tokenStore.ts`
- Test: `test/auth/tokenStore.test.ts`

**Interfaces:**
- Produces: `export interface StoredCredentials { accessToken: string; refreshToken: string; expiresAt: number; storeId: string }` — `expiresAt` is always epoch **milliseconds** after normalization
- Produces: `export const normalizeExpiresAt: (value: number) => number`
- Produces: `export interface TokenStore { read(): StoredCredentials | null; write(credentials: StoredCredentials): void }`
- Produces: `export const createTokenStore: (configDir?: string) => TokenStore` — defaults to `envPaths("hermes-mcp").config`; **tests and any code that must not touch the real user's config dir pass an explicit directory**

- [ ] **Step 1: Write the failing tests**

Create `test/auth/tokenStore.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTokenStore, normalizeExpiresAt } from "../../src/auth/tokenStore.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hermes-mcp-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeExpiresAt", () => {
  it("multiplies a seconds-epoch value up to milliseconds", () => {
    expect(normalizeExpiresAt(1_800_000_000)).toBe(1_800_000_000_000);
  });

  it("leaves a milliseconds-epoch value unchanged", () => {
    expect(normalizeExpiresAt(1_800_000_000_000)).toBe(1_800_000_000_000);
  });
});

describe("createTokenStore", () => {
  it("returns null when no file exists yet", () => {
    expect(createTokenStore(dir).read()).toBeNull();
  });

  it("round-trips written credentials, creating the directory if needed", () => {
    const store = createTokenStore(path.join(dir, "nested"));
    store.write({ accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000_000, storeId: "s1" });
    expect(store.read()).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_800_000_000_000,
      storeId: "s1",
    });
  });

  it("normalizes a seconds-epoch expiresAt on write", () => {
    const store = createTokenStore(dir);
    store.write({ accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000, storeId: "s1" });
    expect(store.read()?.expiresAt).toBe(1_800_000_000_000);
  });

  it("returns null for a corrupt file instead of throwing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "credentials.json"), "not json", "utf-8");
    expect(createTokenStore(dir).read()).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ accessToken: "a" }), "utf-8");
    expect(createTokenStore(dir).read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/auth/tokenStore.test.ts`
Expected: FAIL — `src/auth/tokenStore.ts` does not exist yet, and `env-paths` is not installed.

- [ ] **Step 3: Install `env-paths`**

Run: `npm install env-paths@^3.0.0`
Expected: adds `env-paths` to `dependencies` (already listed in Task 1's `package.json`; this installs it into `node_modules` and the lockfile).

- [ ] **Step 4: Create `src/auth/tokenStore.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import envPaths from "env-paths";

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Always normalized by `write`. */
  expiresAt: number;
  storeId: string;
}

/**
 * Hermes declares `expiresAt` only as `integer` with no unit, so it could be
 * epoch seconds or epoch milliseconds. Anything below this bound (roughly the
 * year 2286 in seconds, far above any plausible epoch-ms value's lower bound)
 * is treated as seconds and scaled up, so every consumer works in one unit.
 */
const SECONDS_EPOCH_THRESHOLD = 10_000_000_000;

export const normalizeExpiresAt = (value: number): number =>
  value < SECONDS_EPOCH_THRESHOLD ? value * 1000 : value;

export interface TokenStore {
  read(): StoredCredentials | null;
  write(credentials: StoredCredentials): void;
}

export const createTokenStore = (
  configDir: string = envPaths("hermes-mcp").config
): TokenStore => {
  const file = path.join(configDir, "credentials.json");
  return {
    read(): StoredCredentials | null {
      if (!existsSync(file)) return null;
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<StoredCredentials>;
        if (
          typeof raw.accessToken !== "string" ||
          typeof raw.refreshToken !== "string" ||
          typeof raw.expiresAt !== "number" ||
          typeof raw.storeId !== "string"
        ) {
          return null;
        }
        return raw as StoredCredentials;
      } catch {
        return null;
      }
    },
    write(credentials: StoredCredentials): void {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ ...credentials, expiresAt: normalizeExpiresAt(credentials.expiresAt) }, null, 2),
        "utf-8"
      );
    },
  };
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/auth/tokenStore.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/auth/tokenStore.ts test/auth/tokenStore.test.ts
git commit -m "feat: persist Hermes credentials under the OS config dir"
```

---

### Task 9: Hermes auth client (login + refresh)

**Files:**
- Create: `src/auth/hermesAuth.ts`
- Test: `test/auth/hermesAuth.test.ts`

**Interfaces:**
- Produces: `export interface LoginStore { id: string; name: string; domain: string }`
- Produces: `export interface WebLoginResult { userId: string; accessToken: string; refreshToken: string; expiresAt: number; isAdmin: boolean; stores: LoginStore[] }`
- Produces: `export interface RefreshResult { accessToken: string; refreshToken: string; expiresAt: number }`
- Produces: `export const webLogin: (baseUrl: string, domain: string, email: string, password: string) => Promise<WebLoginResult>`
- Produces: `export const refreshAccessToken: (baseUrl: string, refreshToken: string) => Promise<RefreshResult>`

- [ ] **Step 1: Write the failing tests**

Create `test/auth/hermesAuth.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAccessToken, webLogin } from "../../src/auth/hermesAuth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webLogin", () => {
  it("sends Basic Auth plus the domain body, and unwraps {data}", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/web");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from("me@x.com:secret", "utf-8").toString("base64")}`
      );
      expect(JSON.parse(init.body as string)).toEqual({ domain: "store.myshopify.com" });
      return new Response(
        JSON.stringify({
          data: {
            userId: "u1",
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 1_800_000_000,
            isAdmin: false,
            stores: [{ id: "s1", name: "My Store", domain: "store.myshopify.com" }],
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webLogin("https://hermes.test", "store.myshopify.com", "me@x.com", "secret");

    expect(result.accessToken).toBe("a");
    expect(result.stores).toEqual([{ id: "s1", name: "My Store", domain: "store.myshopify.com" }]);
  });

  it("reads an unenveloped response body too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              userId: "u1",
              accessToken: "a",
              refreshToken: "r",
              expiresAt: 1_800_000_000,
              isAdmin: false,
              stores: [],
            }),
            { status: 200 }
          )
      )
    );
    const result = await webLogin("https://hermes.test", "d", "e", "p");
    expect(result.accessToken).toBe("a");
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(webLogin("https://hermes.test", "d", "e", "p")).rejects.toThrow(/401/);
  });

  it("never includes the password in a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    try {
      await webLogin("https://hermes.test", "d", "me@x.com", "hunter2");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }
  });
});

describe("refreshAccessToken", () => {
  it("sends the refresh token and unwraps {data}", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/refresh");
      expect(JSON.parse(init.body as string)).toEqual({ refreshToken: "r1" });
      return new Response(
        JSON.stringify({ data: { accessToken: "a2", refreshToken: "r2", expiresAt: 1_800_000_000_000 } }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshAccessToken("https://hermes.test", "r1");

    expect(result).toEqual({ accessToken: "a2", refreshToken: "r2", expiresAt: 1_800_000_000_000 });
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(refreshAccessToken("https://hermes.test", "bad")).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/auth/hermesAuth.test.ts`
Expected: FAIL — `src/auth/hermesAuth.ts` does not exist yet.

- [ ] **Step 3: Create `src/auth/hermesAuth.ts`**

```ts
export interface LoginStore {
  id: string;
  name: string;
  domain: string;
}

export interface WebLoginResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  isAdmin: boolean;
  stores: LoginStore[];
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Hermes wraps some successful bodies in `{ "data": ... }` and some not. */
const unwrap = <T>(payload: unknown): T =>
  (payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload) as T;

const postJson = async (url: URL, body: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Deliberately does not include the request body — it carries the password.
    throw new Error(`Hermes ${url.pathname} failed with status ${response.status}`);
  }
  return response.json();
};

export const webLogin = async (
  baseUrl: string,
  domain: string,
  email: string,
  password: string
): Promise<WebLoginResult> => {
  const basic = Buffer.from(`${email}:${password}`, "utf-8").toString("base64");
  const payload = await postJson(new URL("/api/v1/auth/web", baseUrl), { domain }, {
    Authorization: `Basic ${basic}`,
  });
  return unwrap<WebLoginResult>(payload);
};

export const refreshAccessToken = async (baseUrl: string, refreshToken: string): Promise<RefreshResult> => {
  const payload = await postJson(new URL("/api/v1/auth/refresh", baseUrl), { refreshToken });
  return unwrap<RefreshResult>(payload);
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/auth/hermesAuth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/hermesAuth.ts test/auth/hermesAuth.test.ts
git commit -m "feat: add Hermes web login and token refresh calls"
```

---

### Task 10: TokenManager

**Files:**
- Create: `src/auth/tokenManager.ts`
- Test: `test/auth/tokenManager.test.ts`

**Interfaces:**
- Consumes: `TokenStore`, `StoredCredentials`, `normalizeExpiresAt` from `src/auth/tokenStore.ts` (Task 8); `refreshAccessToken` from `src/auth/hermesAuth.ts` (Task 9); `MissingCredentialsError` from `src/errors.ts` (Task 3); `Credentials` from `src/hermesClient.ts` (Task 4)
- Produces: `export interface TokenManagerDeps { store: TokenStore; baseUrl: string; now?: () => number; refresh?: typeof refreshAccessToken }`
- Produces: `export class TokenManager { constructor(deps: TokenManagerDeps, initial?: StoredCredentials | null); getValidCredentials(): Promise<Credentials>; forceRefresh(): Promise<Credentials> }`

**Note on the env-var fallback:** a credential sourced from
`HERMES_ACCESS_TOKEN`/`HERMES_STORE_ID` has no refresh token and no known
expiry. Task 13 seeds those as `{ refreshToken: "", expiresAt: Number.POSITIVE_INFINITY }`,
which makes `getValidCredentials()` never attempt a proactive refresh for them,
while `forceRefresh()` (the 401 path) still tries and fails cleanly into
`MissingCredentialsError` — the correct outcome for a static token that Hermes
has stopped accepting.

- [ ] **Step 1: Write the failing tests**

Create `test/auth/tokenManager.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../../src/auth/tokenManager.js";
import type { StoredCredentials, TokenStore } from "../../src/auth/tokenStore.js";
import { MissingCredentialsError } from "../../src/errors.js";

const fakeStore = (
  initial: StoredCredentials | null = null
): TokenStore & { written: StoredCredentials[] } => {
  let current = initial;
  const written: StoredCredentials[] = [];
  return {
    read: () => current,
    write: (c) => {
      current = c;
      written.push(c);
    },
    written,
  };
};

const at = (ms: number): (() => number) => () => ms;

describe("TokenManager", () => {
  it("throws MissingCredentialsError when nothing is loaded", async () => {
    const manager = new TokenManager({ store: fakeStore(), baseUrl: "https://hermes.test" }, null);
    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
  });

  it("reads credentials from the store when none are passed in", async () => {
    const stored: StoredCredentials = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_000_000 + 600_000,
      storeId: "s1",
    };
    const manager = new TokenManager({
      store: fakeStore(stored),
      baseUrl: "https://hermes.test",
      now: at(1_000_000),
    });
    expect(await manager.getValidCredentials()).toEqual({ accessToken: "a", storeId: "s1" });
  });

  it("returns the current credentials unchanged when far from expiry", async () => {
    const refresh = vi.fn();
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r", expiresAt: 1_000_000 + 120_000, storeId: "s1" }
    );

    expect(await manager.getValidCredentials()).toEqual({ accessToken: "a", storeId: "s1" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes and persists when within 60s of expiry, keeping the same storeId", async () => {
    const store = fakeStore();
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2_000_000_000_000,
    }));
    const manager = new TokenManager(
      { store, baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 30_000, storeId: "s1" }
    );

    const creds = await manager.getValidCredentials();

    expect(refresh).toHaveBeenCalledWith("https://hermes.test", "r1");
    expect(creds).toEqual({ accessToken: "a2", storeId: "s1" });
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toEqual({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2_000_000_000_000,
      storeId: "s1",
    });
  });

  it("normalizes a seconds-epoch expiresAt returned by the refresh call", async () => {
    const store = fakeStore();
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 1_800_000_000,
    }));
    const manager = new TokenManager(
      { store, baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000, storeId: "s1" }
    );

    await manager.getValidCredentials();

    expect(store.written[0].expiresAt).toBe(1_800_000_000_000);
  });

  it("forceRefresh refreshes even when the token is nowhere near expiry", async () => {
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2_000_000_000_000,
    }));
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 999_000, storeId: "s1" }
    );

    expect((await manager.forceRefresh()).accessToken).toBe("a2");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("throws MissingCredentialsError and stops retrying once the refresh itself fails", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("Hermes /api/v1/auth/refresh failed with status 401");
    });
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "expired", expiresAt: 1_000_000 + 10_000, storeId: "s1" }
    );

    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/auth/tokenManager.test.ts`
Expected: FAIL — `src/auth/tokenManager.ts` does not exist yet.

- [ ] **Step 3: Create `src/auth/tokenManager.ts`**

```ts
import { MissingCredentialsError } from "../errors.js";
import type { Credentials } from "../hermesClient.js";
import { refreshAccessToken } from "./hermesAuth.js";
import { normalizeExpiresAt, type StoredCredentials, type TokenStore } from "./tokenStore.js";

/** Refresh this far ahead of the recorded expiry, to absorb clock skew and latency. */
const EXPIRY_SKEW_MS = 60_000;

export interface TokenManagerDeps {
  store: TokenStore;
  baseUrl: string;
  now?: () => number;
  refresh?: typeof refreshAccessToken;
}

export class TokenManager {
  private current: StoredCredentials | null;
  private readonly store: TokenStore;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly refresh: typeof refreshAccessToken;

  constructor(deps: TokenManagerDeps, initial?: StoredCredentials | null) {
    this.store = deps.store;
    this.baseUrl = deps.baseUrl;
    this.now = deps.now ?? Date.now;
    this.refresh = deps.refresh ?? refreshAccessToken;
    this.current = initial === undefined ? deps.store.read() : initial;
  }

  async getValidCredentials(): Promise<Credentials> {
    if (!this.current) throw new MissingCredentialsError();
    if (this.current.expiresAt - this.now() > EXPIRY_SKEW_MS) {
      return { accessToken: this.current.accessToken, storeId: this.current.storeId };
    }
    return this.refreshNow();
  }

  /** Refreshes regardless of the recorded expiry — the 401-retry-once path. */
  async forceRefresh(): Promise<Credentials> {
    if (!this.current) throw new MissingCredentialsError();
    return this.refreshNow();
  }

  private async refreshNow(): Promise<Credentials> {
    const previous = this.current;
    if (!previous) throw new MissingCredentialsError();

    let refreshed: { accessToken: string; refreshToken: string; expiresAt: number };
    try {
      refreshed = await this.refresh(this.baseUrl, previous.refreshToken);
    } catch {
      // A refresh token Hermes will not honour means no token will work until a
      // fresh login. Drop it so later calls fail fast instead of re-hammering
      // the refresh endpoint on every tool call.
      this.current = null;
      throw new MissingCredentialsError();
    }

    const next: StoredCredentials = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: normalizeExpiresAt(refreshed.expiresAt),
      storeId: previous.storeId,
    };
    this.current = next;
    this.store.write(next);
    return { accessToken: next.accessToken, storeId: next.storeId };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/auth/tokenManager.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/tokenManager.ts test/auth/tokenManager.test.ts
git commit -m "feat: refresh the Hermes token before expiry and persist it"
```

---

### Task 11: Tool registration — token manager, 401 retry, tracing, refresh tool

**Files:**
- Create: `src/tools/index.ts`
- Test: `test/tools/index.test.ts`

**Interfaces:**
- Consumes: `HermesMcpConfig` from `src/config.ts` (Task 1); `Logger` from `src/logging.ts` (Task 2); `MissingCredentialsError`, `HermesUnauthenticatedError`, `toToolResult`, `ToolResult` from `src/errors.ts` (Task 3); `Credentials`, `HermesRequester` from `src/hermesClient.ts` (Task 4); `CompiledEndpoint` from `src/registry/schemaFromOpenApi.ts` (Task 5); `ENDPOINTS` from `src/registry/endpoints.ts`, `SchemaRegistry` from `src/registry/schemaRegistry.ts` (Task 6); `fetchOpenApiDoc` from `src/openapiSync.ts` (Task 7); `TokenManager` from `src/auth/tokenManager.ts` (Task 10)
- Produces: `export interface ToolContext { config: HermesMcpConfig; logger: Logger; tokenManager: TokenManager; registry: SchemaRegistry; createClient: (credentials: Credentials) => HermesRequester }`
- Produces: `export const registerHermesTools: (server: McpServer, ctx: ToolContext) => void` — registers the 11 allowlisted tools plus `hermes_refresh_openapi`

- [ ] **Step 1: Write the failing tests**

Create `test/tools/index.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerHermesTools, type ToolContext } from "../../src/tools/index.js";
import { SchemaRegistry } from "../../src/registry/schemaRegistry.js";
import { loadSnapshotDoc } from "../../src/registry/snapshot.js";
import { ENDPOINTS } from "../../src/registry/endpoints.js";
import { createLogger } from "../../src/logging.js";
import { loadConfig } from "../../src/config.js";
import { TokenManager } from "../../src/auth/tokenManager.js";
import type { StoredCredentials, TokenStore } from "../../src/auth/tokenStore.js";
import type { HermesRequester } from "../../src/hermesClient.js";
import { HermesNotFoundError, HermesUnauthenticatedError } from "../../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const noopStore: TokenStore = { read: () => null, write: () => {} };

const validCredentials: StoredCredentials = {
  accessToken: "t",
  refreshToken: "r",
  expiresAt: Date.now() + 3_600_000,
  storeId: "s1",
};

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
  tokenManager: new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, validCredentials),
  registry: SchemaRegistry.fromDocument(loadSnapshotDoc()),
  createClient: () => ({ request: vi.fn() }) as HermesRequester,
  ...overrides,
});

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("registerHermesTools", () => {
  it("registers every allowlisted tool plus hermes_refresh_openapi", async () => {
    const client = await buildServerAndClient(baseCtx());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...ENDPOINTS.map((e) => e.toolName), "hermes_refresh_openapi"].sort()
    );
  });

  it("calls the injected client with the substituted path and returns its result as text", async () => {
    const request = vi.fn(async () => ({ id: "w1", display: true }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledWith("get", "/api/v1/widgets/w1", { query: {}, body: undefined });
    expect(JSON.parse(textOf(result))).toEqual({ id: "w1", display: true });
  });

  it("returns MISSING_CREDENTIALS and never calls Hermes when no credentials are loaded", async () => {
    const request = vi.fn();
    const client = await buildServerAndClient(
      baseCtx({
        tokenManager: new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, null),
        createClient: () => ({ request }),
      })
    );

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("MISSING_CREDENTIALS");
    expect(request).not.toHaveBeenCalled();
  });

  it("separates path params from query params for hermes_list_custom_blocks", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    await client.callTool({
      name: "hermes_list_custom_blocks",
      arguments: { storeId: "s1", page: 1, contentType: "HTML" },
    });

    expect(request).toHaveBeenCalledWith("get", "/api/v1/stores/s1/custom-blocks", {
      query: { page: "1", contentType: "HTML" },
      body: undefined,
    });
  });

  it("passes the body field through for a create tool", async () => {
    const request = vi.fn(async () => ({ id: "cb1" }));
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));
    const body = {
      name: "n",
      type: "FULLSCREEN",
      contentType: "HTML",
      segregationType: "HOME",
      content: "<div></div>",
    };

    await client.callTool({
      name: "hermes_create_custom_block",
      arguments: { storeId: "s1", body },
    });

    expect(request).toHaveBeenCalledWith("post", "/api/v1/stores/s1/custom-blocks", { query: {}, body });
  });

  it("surfaces a rejected Hermes call as a visible, coded error", async () => {
    const request = vi.fn(async () => {
      throw new HermesNotFoundError("/api/v1/widgets/missing");
    });
    const client = await buildServerAndClient(baseCtx({ createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "missing" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
  });

  it("refreshes the token once and retries on a 401, succeeding on the retry", async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
      return { id: "w1" };
    });
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: Date.now() + 3_600_000,
    }));
    const tokenManager = new TokenManager(
      { store: noopStore, baseUrl: "https://hermes.test", refresh },
      validCredentials
    );
    const client = await buildServerAndClient(baseCtx({ tokenManager, createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("gives up after exactly one retry and surfaces UNAUTHENTICATED", async () => {
    const request = vi.fn(async () => {
      throw new HermesUnauthenticatedError("/api/v1/widgets/w1");
    });
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: Date.now() + 3_600_000,
    }));
    const tokenManager = new TokenManager(
      { store: noopStore, baseUrl: "https://hermes.test", refresh },
      validCredentials
    );
    const client = await buildServerAndClient(baseCtx({ tokenManager, createClient: () => ({ request }) }));

    const result = await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNAUTHENTICATED");
    expect(request).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("logs a debug line and an info line sharing one traceId per call", async () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: "debug" }, (line) => lines.push(line));
    const request = vi.fn(async () => ({ id: "w1" }));
    const client = await buildServerAndClient(baseCtx({ logger, createClient: () => ({ request }) }));

    await client.callTool({ name: "hermes_get_widget", arguments: { id: "w1" } });

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = parsed.find((p) => p.message === "tool call start");
    const ok = parsed.find((p) => p.message === "tool call ok");
    expect(start?.traceId).toBeTypeOf("string");
    expect(ok?.traceId).toBe(start?.traceId);
    expect(start?.path).toBe("/api/v1/widgets/w1");
    expect(start?.method).toBe("get");
  });

  it("hermes_refresh_openapi reports the refreshed count and which tools changed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const doc = loadSnapshotDoc();
        doc.paths["/api/v1/widgets/{id}"].get!.parameters = [];
        return new Response(JSON.stringify(doc), { status: 200 });
      })
    );
    const client = await buildServerAndClient(baseCtx());

    const result = await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(result)) as { refreshed: number; changed: string[] };
    expect(parsed.refreshed).toBe(ENDPOINTS.length);
    expect(parsed.changed).toContain("hermes_get_widget");
  });

  it("hermes_refresh_openapi surfaces a fetch failure as an error result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const client = await buildServerAndClient(baseCtx());

    const result = await client.callTool({ name: "hermes_refresh_openapi", arguments: {} });

    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/index.test.ts`
Expected: FAIL — `src/tools/index.ts` does not exist yet.

- [ ] **Step 3: Create `src/tools/index.ts`**

```ts
import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Logger } from "../logging.js";
import type { HermesMcpConfig } from "../config.js";
import type { SchemaRegistry } from "../registry/schemaRegistry.js";
import type { CompiledEndpoint } from "../registry/schemaFromOpenApi.js";
import { ENDPOINTS } from "../registry/endpoints.js";
import type { Credentials, HermesRequester } from "../hermesClient.js";
import type { TokenManager } from "../auth/tokenManager.js";
import { fetchOpenApiDoc } from "../openapiSync.js";
import { HermesUnauthenticatedError, toToolResult, type ToolResult } from "../errors.js";

export interface ToolContext {
  config: HermesMcpConfig;
  logger: Logger;
  tokenManager: TokenManager;
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

/**
 * The single seam where every cross-cutting concern lives: credential
 * resolution, the one-shot refresh-and-retry on a 401, tracing, timing, and
 * failure mapping. `HermesClient` stays a pure transport precisely so all of
 * this can live here, once.
 */
const wrap =
  (toolName: string, method: string, ctx: ToolContext) =>
  async (args: Record<string, unknown>): Promise<ToolReturn> => {
    const start = Date.now();
    const traceId = randomBytes(4).toString("hex");
    try {
      const compiled = ctx.registry.get(toolName);
      const { path, query, body } = buildRequest(compiled, args);
      const credentials = await ctx.tokenManager.getValidCredentials();

      ctx.logger.debug("tool call start", { tool: toolName, traceId, method, path, query });

      let data: unknown;
      try {
        data = await ctx.createClient(credentials).request(method, path, { query, body });
      } catch (err) {
        if (!(err instanceof HermesUnauthenticatedError)) throw err;
        ctx.logger.debug("tool call retrying after 401", { tool: toolName, traceId });
        const refreshed = await ctx.tokenManager.forceRefresh();
        data = await ctx.createClient(refreshed).request(method, path, { query, body });
      }

      ctx.logger.info("tool call ok", { tool: toolName, traceId, durationMs: Date.now() - start });
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      ctx.logger.info("tool call failed", { tool: toolName, traceId, durationMs: Date.now() - start });
      return toToolResult(err, ctx.logger, toolName);
    }
  };

const REFRESH_TOOL = "hermes_refresh_openapi";

const registerRefreshTool = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    REFRESH_TOOL,
    {
      description:
        "Refresh every hermes_* tool's input schema from the live Hermes OpenAPI document, without waiting for the background interval. Returns how many tool schemas were recompiled and which ones actually changed.",
      inputSchema: z.object({}),
    },
    (async (): Promise<ToolReturn> => {
      const traceId = randomBytes(4).toString("hex");
      const before = new Map(
        ctx.registry.list().map((entry) => [entry.toolName, JSON.stringify(entry.paramLocations)])
      );
      try {
        const doc = await fetchOpenApiDoc(ctx.config.openApiDocsUrl, ctx.config.openApiFetchTimeoutMs);
        ctx.registry.refresh(doc, ctx.logger);
      } catch (err) {
        return toToolResult(err, ctx.logger, REFRESH_TOOL);
      }
      const entries = ctx.registry.list();
      const changed = entries
        .filter((entry) => JSON.stringify(entry.paramLocations) !== before.get(entry.toolName))
        .map((entry) => entry.toolName);
      ctx.logger.info("openapi schema refreshed on demand", {
        traceId,
        refreshed: entries.length,
        changed: changed.length,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ refreshed: entries.length, changed }) }],
      };
    }) as Parameters<typeof server.registerTool>[2]
  );
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
  registerRefreshTool(server, ctx);
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/index.test.ts`
Expected: PASS (11 tests). If TypeScript objects to the
`as Parameters<typeof server.registerTool>[2]` casts, tighten the cast rather
than reaching for `any` — registering tools from a runtime array trades some
generic inference for scalability, and these two casts are where that cost lands.

- [ ] **Step 5: Run the full suite so far**

Run: `npx vitest run`
Expected: PASS — every earlier task's tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts test/tools/index.test.ts
git commit -m "feat: wire tools to the token manager with 401 retry, tracing and a refresh tool"
```

---

### Task 12: Login page, local login server, and CLI entrypoint

**Files:**
- Create: `src/login/loginPage.ts`
- Create: `src/login/loginServer.ts`
- Create: `src/login.ts`
- Test: `test/login/loginServer.test.ts`

**Interfaces:**
- Consumes: `webLogin`, `LoginStore` from `src/auth/hermesAuth.ts` (Task 9); `TokenStore`, `createTokenStore` from `src/auth/tokenStore.ts` (Task 8); `loadConfig` from `src/config.ts` (Task 1)
- Produces: `export const renderLoginForm: (error?: string) => string`
- Produces: `export const renderStorePicker: (stores: LoginStore[]) => string`
- Produces: `export const renderDone: () => string`
- Produces: `export interface LoginServerDeps { hermesBaseUrl: string; store: TokenStore; login?: typeof webLogin; presetStoreId?: string }`
- Produces: `export interface LoginServer { port: number; close(): Promise<void>; waitForCompletion(): Promise<boolean> }`
- Produces: `export const startLoginServer: (deps: LoginServerDeps) => Promise<LoginServer>`

- [ ] **Step 1: Create `src/login/loginPage.ts`**

```ts
import type { LoginStore } from "../auth/hermesAuth.js";

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );

const page = (body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermes-mcp login</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 22rem;
         margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
  label { display: block; margin-top: 0.75rem; font-size: 0.875rem; }
  input { width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box;
          border: 1px solid #8888; border-radius: 4px; font: inherit; }
  button { margin-top: 1.25rem; padding: 0.625rem 1rem; width: 100%; font: inherit;
           border: 1px solid #8888; border-radius: 4px; cursor: pointer; background: #8881; }
  button:hover { background: #8883; }
  .error { color: #b00020; font-size: 0.875rem; margin-top: 1rem; }
  .store button { margin-top: 0.5rem; text-align: left; }
</style>
</head>
<body>${body}</body>
</html>`;

export const renderLoginForm = (error?: string): string =>
  page(`
  <h1>Log in to Hermes</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/login">
    <label>Store domain
      <input name="domain" required placeholder="store.myshopify.com" autofocus>
    </label>
    <label>Email
      <input name="email" type="email" required autocomplete="username">
    </label>
    <label>Password
      <input name="password" type="password" required autocomplete="current-password">
    </label>
    <button type="submit">Log in</button>
  </form>`);

export const renderStorePicker = (stores: LoginStore[]): string =>
  page(`
  <h1>Pick a store</h1>
  ${stores
    .map(
      (store) => `<form class="store" method="post" action="/select-store">
    <input type="hidden" name="storeId" value="${escapeHtml(store.id)}">
    <button type="submit">${escapeHtml(store.name)} — ${escapeHtml(store.domain)}</button>
  </form>`
    )
    .join("\n")}`);

export const renderDone = (): string =>
  page(`
  <h1>Logged in</h1>
  <p>Credentials saved. You can close this tab and start the MCP server.</p>`);
```

- [ ] **Step 2: Write the failing tests for the login server**

Create `test/login/loginServer.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startLoginServer, type LoginServer } from "../../src/login/loginServer.js";
import type { StoredCredentials, TokenStore } from "../../src/auth/tokenStore.js";
import type { WebLoginResult } from "../../src/auth/hermesAuth.js";

let server: LoginServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const fakeStore = (): TokenStore & { written: StoredCredentials[] } => {
  const written: StoredCredentials[] = [];
  return {
    read: () => written[written.length - 1] ?? null,
    write: (credentials) => {
      written.push(credentials);
    },
    written,
  };
};

const loginResult = (stores: WebLoginResult["stores"]): WebLoginResult => ({
  userId: "u1",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 1_800_000_000_000,
  isAdmin: false,
  stores,
});

const postJson = (port: number, path: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("startLoginServer", () => {
  it("serves the login form on GET /", async () => {
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store: fakeStore() });

    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('name="domain"');
    expect(text).toContain('name="password"');
  });

  it("persists credentials and completes when the login returns exactly one store", async () => {
    const store = fakeStore();
    const login = async () => loginResult([{ id: "s1", name: "My Store", domain: "one.myshopify.com" }]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const response = await postJson(server.port, "/login", {
      domain: "one.myshopify.com",
      email: "me@x.com",
      password: "secret",
    });

    expect(response.status).toBe(200);
    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written).toEqual([
      { accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000_000, storeId: "s1" },
    ]);
  });

  it("shows a picker for multiple stores, then persists the picked one", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const pickerHtml = await (
      await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "secret" })
    ).text();
    expect(pickerHtml).toContain("Store One");
    expect(pickerHtml).toContain("Store Two");
    expect(store.written).toHaveLength(0);

    const response = await postJson(server.port, "/select-store", { storeId: "s2" });

    expect(response.status).toBe(200);
    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written[0]).toMatchObject({ storeId: "s2", accessToken: "a" });
  });

  it("skips the picker when presetStoreId is given, even with multiple stores", async () => {
    const store = fakeStore();
    const login = async () =>
      loginResult([
        { id: "s1", name: "Store One", domain: "one.myshopify.com" },
        { id: "s2", name: "Store Two", domain: "two.myshopify.com" },
      ]);
    server = await startLoginServer({
      hermesBaseUrl: "https://hermes.test",
      store,
      login,
      presetStoreId: "s2",
    });

    await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "secret" });

    expect(await server.waitForCompletion()).toBe(true);
    expect(store.written[0]).toMatchObject({ storeId: "s2" });
  });

  it("accepts a urlencoded body, as a real browser form submits", async () => {
    const store = fakeStore();
    const login = async () => loginResult([{ id: "s1", name: "One", domain: "one.myshopify.com" }]);
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const response = await fetch(`http://127.0.0.1:${server.port}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ domain: "x", email: "me@x.com", password: "secret" }).toString(),
    });

    expect(response.status).toBe(200);
    expect(store.written).toHaveLength(1);
  });

  it("re-renders the form with the error when login fails, without persisting or crashing", async () => {
    const store = fakeStore();
    const login = async () => {
      throw new Error("Hermes /api/v1/auth/web failed with status 401");
    };
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store, login });

    const text = await (
      await postJson(server.port, "/login", { domain: "x", email: "me@x.com", password: "wrong" })
    ).text();

    expect(text).toContain("401");
    expect(text).toContain('name="password"');
    expect(store.written).toHaveLength(0);

    const stillUp = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(stillUp.status).toBe(200);
  });

  it("rejects /select-store before a successful login", async () => {
    const store = fakeStore();
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store });

    const response = await postJson(server.port, "/select-store", { storeId: "s1" });

    expect(response.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it("binds to 127.0.0.1 only", async () => {
    server = await startLoginServer({ hermesBaseUrl: "https://hermes.test", store: fakeStore() });
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/login/loginServer.test.ts`
Expected: FAIL — `src/login/loginServer.ts` does not exist yet.

- [ ] **Step 4: Create `src/login/loginServer.ts`**

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { webLogin } from "../auth/hermesAuth.js";
import type { LoginStore } from "../auth/hermesAuth.js";
import type { TokenStore } from "../auth/tokenStore.js";
import { renderDone, renderLoginForm, renderStorePicker } from "./loginPage.js";

export interface LoginServerDeps {
  hermesBaseUrl: string;
  store: TokenStore;
  login?: typeof webLogin;
  presetStoreId?: string;
}

export interface LoginServer {
  port: number;
  close(): Promise<void>;
  /** Resolves true once credentials are persisted, false if closed without a login. */
  waitForCompletion(): Promise<boolean>;
}

const readBody = async (req: http.IncomingMessage): Promise<Record<string, string>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }
  return Object.fromEntries(new URLSearchParams(raw));
};

const html = (res: http.ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};

export const startLoginServer = (deps: LoginServerDeps): Promise<LoginServer> => {
  const login = deps.login ?? webLogin;
  let pending: { accessToken: string; refreshToken: string; expiresAt: number } | null = null;
  let settle: (ok: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const persist = (storeId: string): void => {
    if (!pending) throw new Error("No pending login to persist.");
    deps.store.write({ ...pending, storeId });
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/") {
          html(res, 200, renderLoginForm());
          return;
        }

        if (req.method === "POST" && req.url === "/login") {
          const body = await readBody(req);
          const result = await login(
            deps.hermesBaseUrl,
            body.domain ?? "",
            body.email ?? "",
            body.password ?? ""
          );
          pending = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt,
          };

          const only: LoginStore | undefined = result.stores.length === 1 ? result.stores[0] : undefined;
          const storeId = deps.presetStoreId ?? only?.id;
          if (storeId) {
            persist(storeId);
            html(res, 200, renderDone());
            settle(true);
            return;
          }

          html(res, 200, renderStorePicker(result.stores));
          return;
        }

        if (req.method === "POST" && req.url === "/select-store") {
          const body = await readBody(req);
          if (!pending || !body.storeId) {
            html(res, 400, renderLoginForm("Log in again."));
            return;
          }
          persist(body.storeId);
          html(res, 200, renderDone());
          settle(true);
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      } catch (err) {
        html(res, 200, renderLoginForm(err instanceof Error ? err.message : String(err)));
      }
    })();
  });

  return new Promise<LoginServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            settle(false);
            server.close(() => done());
          }),
        waitForCompletion: () => completion,
      });
    });
  });
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/login/loginServer.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Create `src/login.ts` (the CLI entrypoint)**

```ts
#!/usr/bin/env node
import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import { createTokenStore } from "./auth/tokenStore.js";
import { startLoginServer } from "./login/loginServer.js";

const openBrowser = (url: string): void => {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {
    // A failure here is not fatal — the URL is printed for manual opening.
  });
};

const parseStoreFlag = (argv: string[]): string | undefined => {
  const index = argv.indexOf("--store");
  return index >= 0 ? argv[index + 1] : undefined;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const server = await startLoginServer({
    hermesBaseUrl: config.hermesBaseUrl,
    store: createTokenStore(),
    presetStoreId: parseStoreFlag(process.argv.slice(2)),
  });

  const url = `http://127.0.0.1:${server.port}/`;
  process.stderr.write(`Opening ${url}\nIf your browser does not open, visit that URL.\n`);
  openBrowser(url);

  const ok = await server.waitForCompletion();
  await server.close();
  process.stderr.write(ok ? "Logged in. Credentials saved.\n" : "Login did not complete.\n");
  process.exit(ok ? 0 : 1);
};

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS — including the stdout-discipline check once Task 13 adds it
(`src/login.ts` writes to stderr only, never stdout).

- [ ] **Step 8: Commit**

```bash
git add src/login/loginPage.ts src/login/loginServer.ts src/login.ts test/login/loginServer.test.ts
git commit -m "feat: add the local browser login flow and its CLI entrypoint"
```

---

### Task 13: Server entrypoint + integration test

**Files:**
- Create: `src/server.ts`
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `HermesMcpConfig` from `src/config.ts` (Task 1); `createLogger`, `Logger` from `src/logging.ts` (Task 2); `HermesClient` from `src/hermesClient.ts` (Task 4); `SchemaRegistry` from `src/registry/schemaRegistry.ts`, `loadSnapshotDoc` from `src/registry/snapshot.ts`, `ENDPOINTS` from `src/registry/endpoints.ts` (Task 6); `startOpenApiRefreshLoop` from `src/openapiSync.ts` (Task 7); `createTokenStore`, `StoredCredentials` from `src/auth/tokenStore.ts` (Task 8); `TokenManager` from `src/auth/tokenManager.ts` (Task 10); `registerHermesTools` from `src/tools/index.ts` (Task 11)
- Produces: `export const createServer: (config?: HermesMcpConfig, logger?: Logger, tokenManager?: TokenManager) => McpServer`

**Why `tokenManager` is a parameter:** its default builds a real
`createTokenStore()`, which reads the developer's actual
`%APPDATA%\hermes-mcp\credentials.json`. Tests must pass their own manager so a
real prior login on the machine can never change a test's outcome.

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
import { ENDPOINTS } from "./registry/endpoints.js";
import { startOpenApiRefreshLoop } from "./openapiSync.js";
import { HermesClient } from "./hermesClient.js";
import { createTokenStore, type StoredCredentials } from "./auth/tokenStore.js";
import { TokenManager } from "./auth/tokenManager.js";

/**
 * Prefers a persisted login; falls back to the static env-var credential.
 * The env-var form has no refresh token and no known expiry, so it is seeded
 * with an infinite expiry — never proactively refreshed, but still able to fail
 * cleanly into MissingCredentialsError if Hermes rejects it.
 */
const buildTokenManager = (config: HermesMcpConfig): TokenManager => {
  const store = createTokenStore();
  const fromEnv: StoredCredentials | null = config.credentials
    ? {
        accessToken: config.credentials.accessToken,
        storeId: config.credentials.storeId,
        refreshToken: "",
        expiresAt: Number.POSITIVE_INFINITY,
      }
    : null;
  return new TokenManager({ store, baseUrl: config.hermesBaseUrl }, store.read() ?? fromEnv);
};

/**
 * Builds a fully configured server without connecting it to a transport.
 * Kept separate from stdio setup so tests can drive a real server over
 * InMemoryTransport, matching vajro-custom-blocks-sdk/mcp's own pattern.
 */
export const createServer = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config),
  tokenManager: TokenManager = buildTokenManager(config)
): McpServer => {
  const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
  startOpenApiRefreshLoop(registry, config, logger);

  const server = new McpServer({ name: config.serverName, version: config.serverVersion });
  registerHermesTools(server, {
    config,
    logger,
    tokenManager,
    registry,
    createClient: (credentials) => new HermesClient(config.hermesBaseUrl, credentials),
  });

  logger.info("server ready", { tools: ENDPOINTS.length + 1 });
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
import { TokenManager } from "../src/auth/tokenManager.js";
import type { StoredCredentials, TokenStore } from "../src/auth/tokenStore.js";

const noopStore: TokenStore = { read: () => null, write: () => {} };

const connect = async (tokenManager: TokenManager, name: string): Promise<Client> => {
  const config = loadConfig({ HERMES_MCP_LOG_LEVEL: "silent" });
  const server = createServer(config, createLogger(config, () => {}), tokenManager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const stubDocsOnlyFetch = (): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ paths: {} }), { status: 200 }))
  );
};

let client: Client;

beforeAll(async () => {
  stubDocsOnlyFetch();
  client = await connect(
    new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, null),
    "integration-test"
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools/list", () => {
  it("advertises every allowlisted tool plus hermes_refresh_openapi, each with a description and schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...ENDPOINTS.map((e) => e.toolName), "hermes_refresh_openapi"].sort()
    );
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(5);
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });
});

describe("credentials", () => {
  it("rejects a Hermes-backed tool call with MISSING_CREDENTIALS when nothing is loaded", async () => {
    const result = await client.callTool({ name: "hermes_get_active_theme", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("MISSING_CREDENTIALS");
  });
});

describe("an end-to-end call through the real TokenManager and HermesClient", () => {
  it("calls hermes_get_active_theme and unwraps the {data} envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        String(url).endsWith("/v3/api-docs")
          ? new Response(JSON.stringify({ paths: {} }), { status: 200 })
          : new Response(JSON.stringify({ data: { id: "theme-1" } }), { status: 200 })
      )
    );
    const credentials: StoredCredentials = {
      accessToken: "test-token",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      storeId: "store-1",
    };
    const authed = await connect(
      new TokenManager({ store: noopStore, baseUrl: "https://hermes.test" }, credentials),
      "authed-test-client"
    );

    const result = await authed.callTool({ name: "hermes_get_active_theme", arguments: {} });

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

- [ ] **Step 3: Run the integration test**

Run: `npx vitest run test/integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS — every test file from every task green.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/integration.test.ts
git commit -m "feat: add stdio server entrypoint wired to the token manager"
```

---

### Task 14: Build script, README, and registration docs

**Files:**
- Create: `scripts/build.mjs`
- Create: `README.md`

**Interfaces:**
- Consumes: `src/server.ts` (Task 13) and `src/login.ts` (Task 12) as the two bundle entry points
- Produces: `dist/server.js` and `dist/login.js` (build artifacts, gitignored)

- [ ] **Step 1: Create `scripts/build.mjs`**

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts", "src/login.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  external: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio", "zod", "env-paths"],
  logLevel: "info",
});
```

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: creates `dist/server.js` and `dist/login.js` with no errors. Each keeps
its `#!/usr/bin/env node` shebang as the first line (esbuild preserves it).

- [ ] **Step 3: Smoke-test the built server over stdio**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/server.js`
Expected: one JSON-RPC response on stdout listing 12 tools (11 `hermes_*`
operations plus `hermes_refresh_openapi`); any log lines appear on stderr, never
interleaved into the stdout JSON.

- [ ] **Step 4: Smoke-test the login CLI's page rendering without completing a login**

Run: `node dist/login.js` then, in another terminal, `curl -s http://127.0.0.1:<printed port>/ | head -20`
Expected: the printed URL opens (or curl returns) the login form HTML. Press
Ctrl+C to abort — no credentials file is written unless a login completes.

- [ ] **Step 5: Create `README.md`**

````markdown
# hermes-mcp

A stdio MCP server exposing a curated set of Hermes Atlas REST endpoints as
tools, authenticated with a token you obtain once through a local browser login.

Design docs:
[base design](docs/superpowers/specs/2026-09-08-hermes-mcp-design.md) ·
[auth, tracing & refresh](docs/superpowers/specs/2026-09-08-hermes-mcp-auth-design.md)

## Quick start

```bash
npm install
npm run build     # esbuild -> dist/server.js and dist/login.js
npm run login     # opens a browser, logs in, saves your token
npm start         # node dist/server.js -- speaks MCP over stdio
```

## Logging in

`npm run login` (or `node dist/login.js`) starts a short-lived local server on
`127.0.0.1`, opens your browser to a login form, and calls Hermes's Web login
(`POST /api/v1/auth/web`). If your account has access to one store it is chosen
automatically; with several, the page shows a picker. Pass `--store <id>` to skip
the picker non-interactively.

The resulting token pair is saved to `credentials.json` in your OS config
directory (`%APPDATA%\hermes-mcp\` on Windows, `~/.config/hermes-mcp/` on Linux,
`~/Library/Application Support/hermes-mcp/` on macOS) — never inside this repo.
The server refreshes that token automatically before it expires, and once more if
Hermes unexpectedly rejects it, so you should rarely need to log in again.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HERMES_MCP_LOG_LEVEL` | `info` | `silent`\|`error`\|`warn`\|`info`\|`debug` |
| `HERMES_BASE_URL` | `https://hermes-atlas.vajro.com` | Host root tool calls and login go to |
| `HERMES_OPENAPI_DOCS_URL` | `https://hermes-atlas.vajro.com/v3/api-docs` | Where tool schemas refresh from |
| `HERMES_OPENAPI_REFRESH_INTERVAL_S` | `900` | Background schema refresh interval |
| `HERMES_ACCESS_TOKEN` | — | Fallback for CI/scripting; used only when no `credentials.json` exists. Set with `HERMES_STORE_ID` or neither. |
| `HERMES_STORE_ID` | — | See above |

## Register with Claude Code

`dist/` is a build artifact and is not committed — run `npm run build` once
before registering, and again after any change under `src/`.

```bash
claude mcp add hermes-mcp --scope user -e HERMES_MCP_LOG_LEVEL=info \
  -- node "/absolute/path/to/hermes-mcp/dist/server.js"
```

Credentials come from your saved login, so no token needs to go in that command.
Verify with `claude mcp list` and `claude mcp get hermes-mcp`.

## Tools

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
| `hermes_refresh_openapi` | — (recompiles the schemas above from the live spec) |

Every tool's input schema is compiled from Hermes's own OpenAPI document, and
refreshed from the live spec at startup, every 15 minutes, and whenever
`hermes_refresh_openapi` is called. Adding a twelfth Hermes operation is one
entry in `src/registry/endpoints.ts`; `test/registry/schemaRegistry.test.ts`
fails loudly if it doesn't compile against the checked-in snapshot.

## Debugging

Set `HERMES_MCP_LOG_LEVEL=debug` to get, per tool call, a `tool call start` line
with the resolved method/path/query and a matching `tool call ok` (or
`tool call failed`) line — both tagged with the same short `traceId`, so one
call's full path through the server can be grepped out of the stderr stream.
Tokens are never logged at any level.

## Tests

```bash
npm test
npm run test:watch
```

## Hard constraints

1. Never write to stdout under `src/` — stdout is the MCP transport.
2. Never store a credential anywhere but the one `credentials.json` under the OS
   config dir.
3. Never expose a Hermes operation that isn't a named entry in
   `src/registry/endpoints.ts`.
4. Never log a token, at any log level.
````

- [ ] **Step 6: Run the full suite one last time**

Run: `npm test`
Expected: PASS — all tests across all fourteen tasks green.

- [ ] **Step 7: Commit**

```bash
git add scripts/build.mjs README.md
git commit -m "feat: add esbuild build for both entrypoints and the README"
```

---

## Post-plan checklist (not a task — do after Task 14)

- `Superfans.code-workspace` already lists `hermes-mcp` as a folder (added when
  the repo was created, before this plan was written).
- Do not run `claude mcp add` or `npm run login` on the user's behalf — the first
  edits their global Claude Code config, the second prompts for their real Hermes
  password. Both are theirs to run.
- Confirm the real shape of Hermes's `expiresAt` (seconds vs milliseconds) on the
  first real login and adjust `SECONDS_EPOCH_THRESHOLD` in
  `src/auth/tokenStore.ts` if the normalization guessed wrong.

---

### Task 15: Switch the login to email + one-time code, and register the chosen store

**Files:**
- Modify: `src/auth/hermesAuth.ts`
- Modify: `src/login/loginPage.ts`
- Modify: `src/login/loginServer.ts`
- Modify: `test/auth/hermesAuth.test.ts`
- Modify: `test/login/loginServer.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `TokenStore` from `src/auth/tokenStore.ts`; `LoginStore`, `WebLoginResult`, `RefreshResult` unchanged
- Produces (replacing the old `webLogin` signature):
  - `export const sendEmailOtp: (baseUrl: string, email: string) => Promise<void>`
  - `export const webLogin: (baseUrl: string, email: string, otp: string) => Promise<WebLoginResult>`
  - `export const storeLogin: (baseUrl: string, accessToken: string, storeId: string) => Promise<void>`
  - `export const renderEmailForm: (error?: string) => string`
  - `export const renderOtpForm: (email: string, error?: string) => string`
  - `LoginServerDeps` gains `sendOtp?: typeof sendEmailOtp` and `selectStore?: typeof storeLogin`; `login?: typeof webLogin` keeps its name with the new signature

**Why this changes:** the Dashboard's own `packages/api/services/auth.ts` is the
reference for what `POST /api/v1/auth/web` expects, and it sends an **empty body**
with `Authorization: Basic base64(email + ":" + otp)` — the Basic-auth password
slot carries a one-time code mailed by `POST /api/v1/otp/email/send`, and there is
no `domain` field. Hermes has no email+password login at all. After a store is
chosen, the Dashboard's switcher calls `POST /api/v1/auth/stores/login` with an
empty body and an `X-Store-Id` header to register the choice.

- [ ] **Step 1: Replace the auth calls in `src/auth/hermesAuth.ts`**

Delete the existing `webLogin`. Update `postJson`'s comment and add the three
functions below. Keep `LoginStore`, `WebLoginResult`, `RefreshResult`, `unwrap`
and `refreshAccessToken` exactly as they are.

```ts
const postJson = async (url: URL, body: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Names only the path and status: the Authorization header carries the OTP.
    throw new Error(`Hermes ${url.pathname} failed with status ${response.status}`);
  }
  return response.json();
};

/** Mails a one-time code. Sends no Authorization header — this call precedes having a token. */
export const sendEmailOtp = async (baseUrl: string, email: string): Promise<void> => {
  await postJson(new URL("/api/v1/otp/email/send", baseUrl), { email });
};

/**
 * Exchanges an emailed one-time code for a token pair.
 * The Basic-auth password slot carries the OTP, not a password, and the body is
 * empty — this mirrors the Dashboard's own call exactly.
 */
export const webLogin = async (baseUrl: string, email: string, otp: string): Promise<WebLoginResult> => {
  const basic = Buffer.from(`${email}:${otp}`, "utf-8").toString("base64");
  const payload = await postJson(new URL("/api/v1/auth/web", baseUrl), {}, {
    Authorization: `Basic ${basic}`,
  });
  return unwrap<WebLoginResult>(payload);
};

/** Registers the chosen store server-side. The response body is not inspected — only success matters. */
export const storeLogin = async (baseUrl: string, accessToken: string, storeId: string): Promise<void> => {
  await postJson(new URL("/api/v1/auth/stores/login", baseUrl), {}, {
    Authorization: `Bearer ${accessToken}`,
    "X-Store-Id": storeId,
  });
};
```

- [ ] **Step 2: Replace the form renderers in `src/login/loginPage.ts`**

Replace `renderLoginForm` with these two. Leave `escapeHtml`, `page`,
`renderStorePicker` and `renderDone` untouched.

```ts
export const renderEmailForm = (error?: string): string =>
  page(`
  <h1>Log in to Hermes</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/request-otp">
    <label>Email
      <input name="email" type="email" required autofocus autocomplete="username">
    </label>
    <button type="submit">Email me a code</button>
  </form>`);

export const renderOtpForm = (email: string, error?: string): string =>
  page(`
  <h1>Enter your code</h1>
  <p>We emailed a one-time code to ${escapeHtml(email)}.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/verify-otp">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <label>One-time code
      <input name="otp" required autofocus autocomplete="one-time-code" inputmode="numeric">
    </label>
    <button type="submit">Log in</button>
  </form>`);
```

- [ ] **Step 3: Rework the routes in `src/login/loginServer.ts`**

Change the imports to bring in `sendEmailOtp`, `storeLogin`, `webLogin` and the
two new renderers. Extend `LoginServerDeps`:

```ts
export interface LoginServerDeps {
  hermesBaseUrl: string;
  store: TokenStore;
  sendOtp?: typeof sendEmailOtp;
  login?: typeof webLogin;
  selectStore?: typeof storeLogin;
  presetStoreId?: string;
}
```

Inside `startLoginServer`, resolve all three doubles and keep the pending state
as it is:

```ts
const sendOtp = deps.sendOtp ?? sendEmailOtp;
const login = deps.login ?? webLogin;
const selectStore = deps.selectStore ?? storeLogin;
```

Replace `persist(storeId)` with a version that registers the store first, so no
path can persist a store Hermes did not accept:

```ts
const registerAndPersist = async (storeId: string): Promise<void> => {
  if (!pending) throw new Error("No pending login to persist.");
  await selectStore(deps.hermesBaseUrl, pending.accessToken, storeId);
  deps.store.write({
    accessToken: pending.accessToken,
    refreshToken: pending.refreshToken,
    expiresAt: pending.expiresAt,
    storeId,
  });
};
```

Replace the `POST /login` branch with the two branches below. The preset /
single-store / picker logic and its `isKnownStore` validation stay exactly as
they were, except that each `persist(...)` becomes `await registerAndPersist(...)`.

```ts
if (req.method === "POST" && req.url === "/request-otp") {
  const body = await readBody(req);
  const email = body.email ?? "";
  await sendOtp(deps.hermesBaseUrl, email);
  html(res, 200, renderOtpForm(email));
  return;
}

if (req.method === "POST" && req.url === "/verify-otp") {
  const body = await readBody(req);
  const email = body.email ?? "";
  let result;
  try {
    result = await login(deps.hermesBaseUrl, email, body.otp ?? "");
  } catch (err) {
    // A wrong or expired code is worth retrying on the same screen.
    html(res, 200, renderOtpForm(email, err instanceof Error ? err.message : String(err)));
    return;
  }
  pending = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    stores: result.stores,
  };

  if (deps.presetStoreId) {
    if (!isKnownStore(result.stores, deps.presetStoreId)) {
      const available = result.stores.map((store) => store.id).join(", ") || "none";
      html(res, 400, renderEmailForm(
        `Store "${deps.presetStoreId}" is not available to this account. Available store ids: ${available}.`
      ));
      // A bad --store flag will not fix itself on retry — don't let the CLI hang forever.
      settle(false);
      return;
    }
    await registerAndPersist(deps.presetStoreId);
    html(res, 200, renderDone());
    settle(true);
    return;
  }

  if (result.stores.length === 1) {
    await registerAndPersist(result.stores[0].id);
    html(res, 200, renderDone());
    settle(true);
    return;
  }

  html(res, 200, renderStorePicker(result.stores));
  return;
}
```

Update the `POST /select-store` branch to `await registerAndPersist(body.storeId)`
and to render `renderEmailForm` on its 400. Update the `GET /` branch and the
outer `catch` to render `renderEmailForm`.

- [ ] **Step 4: Update `test/auth/hermesAuth.test.ts`**

Rewrite the `webLogin` describe block for the new signature and add blocks for
the two new functions. Keep the `refreshAccessToken` block as it is. Add
`sendEmailOtp` and `storeLogin` to the imports.

```ts
describe("sendEmailOtp", () => {
  it("posts the email and sends no Authorization header", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/otp/email/send");
      expect(init.body).toBe(JSON.stringify({ email: "me@x.com" }));
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: { message: "sent" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendEmailOtp("https://hermes.test", "me@x.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("webLogin", () => {
  it("sends Basic base64(email:otp) with an empty body and maps the response", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/web");
      expect(init.body).toBe("{}");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("me@x.com:123456", "utf-8").toString("base64")}`
      );
      return new Response(
        JSON.stringify({
          data: {
            userId: "u1",
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 1_800_000_000_000,
            isAdmin: false,
            stores: [{ id: "s1", name: "Store One", domain: "one.myshopify.com" }],
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await webLogin("https://hermes.test", "me@x.com", "123456");
    expect(result.accessToken).toBe("a");
    expect(result.stores).toHaveLength(1);
  });

  it("never includes the one-time code in a thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    const error = await webLogin("https://hermes.test", "me@x.com", "123456").catch(
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("123456");
  });
});

describe("storeLogin", () => {
  it("sends the store id as a header with an empty body", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/auth/stores/login");
      expect(init.body).toBe("{}");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer a");
      expect(headers["X-Store-Id"]).toBe("s1");
      return new Response(JSON.stringify({ data: { message: "ok" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await storeLogin("https://hermes.test", "a", "s1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(storeLogin("https://hermes.test", "a", "s1")).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 5: Update `test/login/loginServer.test.ts`**

Adapt every existing test to the two-step flow: where a test previously POSTed
`/login` with `{domain, email, password}`, it now POSTs `/verify-otp` with
`{email, otp}`. Give every test's deps a `selectStore` double
(`vi.fn(async () => {})`) so no test reaches the real Hermes. The `storeId`
validation tests keep their assertions unchanged — that logic is untouched.

Define this `login` double next to the existing fakes:

```ts
const singleStoreLogin = async () => ({
  userId: "u1",
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 1_800_000_000_000,
  isAdmin: false,
  stores: [{ id: "s1", name: "Store One", domain: "one.myshopify.com" }],
});
```

Add these four cases:

```ts
it("emails a code and shows the code form", async () => {
  const sendOtp = vi.fn(async () => {});
  server = await startLoginServer({ ...baseDeps(), sendOtp });

  const res = await fetch(`http://127.0.0.1:${server.port}/request-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "me@x.com" }),
  });

  expect(res.status).toBe(200);
  expect(await res.text()).toContain("one-time code");
  expect(sendOtp).toHaveBeenCalledWith(expect.any(String), "me@x.com");
});

it("re-renders the code form with an error when the code is wrong", async () => {
  const login = vi.fn(async () => {
    throw new Error("Hermes /api/v1/auth/web failed with status 401");
  });
  server = await startLoginServer({ ...baseDeps(), login });

  const res = await fetch(`http://127.0.0.1:${server.port}/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "me@x.com", otp: "000000" }),
  });

  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("one-time code");
  expect(body).toContain("401");
});

it("registers the chosen store before persisting", async () => {
  const selectStore = vi.fn(async () => {});
  const store = fakeStore();
  server = await startLoginServer({ ...baseDeps(), store, selectStore, login: singleStoreLogin });

  await fetch(`http://127.0.0.1:${server.port}/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "me@x.com", otp: "123456" }),
  });

  expect(selectStore).toHaveBeenCalledWith(expect.any(String), "a", "s1");
  expect(store.written).toHaveLength(1);
});

it("persists nothing when registering the store fails", async () => {
  const selectStore = vi.fn(async () => {
    throw new Error("Hermes /api/v1/auth/stores/login failed with status 403");
  });
  const store = fakeStore();
  server = await startLoginServer({ ...baseDeps(), store, selectStore, login: singleStoreLogin });

  await fetch(`http://127.0.0.1:${server.port}/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "me@x.com", otp: "123456" }),
  });

  expect(store.written).toHaveLength(0);
});
```

Adapt the helper names above (`baseDeps()`, `fakeStore()`) to whatever the
existing test file already calls them; do not rename existing helpers.

- [ ] **Step 6: Run the covering tests**

Run: `npx vitest run test/auth/hermesAuth.test.ts test/login/loginServer.test.ts`
Expected: PASS.

- [ ] **Step 7: Update `README.md`**

In the login section, replace any mention of a store domain or a password with
the actual flow: run the login command, enter your email, enter the code Hermes
emails you, then pick a store if your account has more than one. Keep `--store`
documented, noting it is validated against the stores your account can access.

- [ ] **Step 8: Typecheck and the full suite**

Run: `npm run typecheck` then `npx vitest run`
Expected: both clean; suite green apart from the known `test/logging.test.ts` line.

- [ ] **Step 9: Commit**

```bash
git add src/auth/hermesAuth.ts src/login/loginPage.ts src/login/loginServer.ts test/auth/hermesAuth.test.ts test/login/loginServer.test.ts README.md
git commit -m "feat: log in with an emailed one-time code and register the chosen store"
```

---

### Task 16: Restyle the login screens to match the Dashboard

> **Supersedes an earlier draft of this task.** That draft also proposed sourcing
> the store list from `POST /v1/auth/refresh`. It was written without knowledge of
> commit `33e3b2f`, which had already fixed the empty-picker defect a different
> and better way — by letting an admin search for stores
> (`GET /api/v1/stores/search`, a `/search-stores` route, a dropdown that keeps
> unusable stores visible but disabled). That fix is tested and working, so this
> task is **UI only**: no logic, no routes, no endpoints change.

**Files:**
- Modify: `src/login/loginPage.ts`
- Modify: `test/login/loginServer.test.ts` (only if a copy assertion needs updating)

**Interfaces:** unchanged. Every export keeps its exact current signature —
`renderEmailForm(error?)`, `renderOtpForm(email, error?)`,
`renderStorePicker(view: StorePickerView)`, `renderMessage(heading, body)`,
`renderDone()`, and the `StorePickerView` interface. `src/login/loginServer.ts`
must not change at all.

**What this is:** the login screens currently use placeholder styling (system
font, `#8888` borders, 4px radii, `background: canvas`). Restyle them to match
the Dashboard's own login screen, whose values are resolved below, and upgrade
the one-time-code field to the eight separate boxes the Dashboard uses.

**Design values**, taken from the Dashboard: `apps/platform/src/index.css` (the
`:root` palette), `apps/platform/tailwind.config.js` (`shadow-v1`, font scale),
`packages/theme/lib/index.ts` (typography), and
`packages/components/src/{input,button,otpInput}`:

| Thing | Value |
|---|---|
| Font | `Figtree` (Google Fonts), root font-size **14px** |
| Primary button | bg `#915ee9`, hover `#8948df`, active `#7935cc`, white text, 14px/600, min-height 36px, padding 8px 16px, radius 8px |
| Card | white, border `1px solid #efeff0`, radius **16px**, shadow `1px 1px 16px 0 rgba(0,0,0,0.08)`, padding 24px, max-width **448px**, centered |
| Heading "Welcome back to" | 24px / 36px line-height, weight 600, colour `#323234` |
| Card heading | 20px, weight 600 |
| Body text | `#323234`; muted `#8e8f95` |
| Label | 14px, weight 500, colour `#7e7f86` |
| Input | min-height 40px, padding 8px 12px, 14px, radius 8px, border `#cfd0d3`, placeholder `#babbc0`, focus outline `1px solid #92939b`, text `#66666e` |
| Error text | `#a40d3c`, 12px |
| OTP boxes | 8 boxes, 40px square (48px ≥640px), centered, gap 8px, radius 8px, focus outline primary |
| Logo | `https://res.cloudinary.com/vajrohq/image/upload/q_auto/v1765299026/modernization/xrumgrtdbb2fyenxkkoa.png`, rendered ~200px wide |

Dashboard copy worth adopting: `Welcome back to` above the logo, `Login` as the
email screen's button, `Sign In` as the code screen's heading,
`Enter the verification code sent to:` above the email address, `Verify OTP` as
its button, and `Select a Store` as the picker heading.

**Four things the tests pin — do not break them:**
- The code screen must still contain the literal phrase **`one-time code`** (two tests assert it) and an input named **`otp`**. The eight boxes therefore post through one hidden `name="otp"` field, and the boxes keep a visible label containing that phrase.
- The picker must still emit `<select name="storeId"` and options of the exact form `<option value="s1">Store One…` / `<option value="" disabled>… (modernization not enabled)</option>`.
- The search form must still post to `/search-stores` with an input named `query`.
- The email screen must still have `name="email"` and must not contain `name="domain"` or `name="password"`.

Keep `escapeHtml`, `storeLabel`, `storeOption`, `searchBox`, `storeDropdown`,
and all of `renderStorePicker`'s choosable/empty-note logic exactly as they are —
restyle their markup, don't rewrite their behaviour.

- [ ] **Step 1: Replace the `<style>` block and the page shell in `src/login/loginPage.ts`**

Swap the current `page()` for a styled shell. Keep the function's name and its
single-string-argument signature so every caller is unaffected.

```ts
/** The Superfans wordmark the Dashboard's own login screen loads. */
const LOGO_URL =
  "https://res.cloudinary.com/vajrohq/image/upload/q_auto/v1765299026/modernization/xrumgrtdbb2fyenxkkoa.png";

const page = (body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermes-mcp login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Palette and metrics mirror the Dashboard's design tokens. */
  :root {
    --primary-400: #915ee9;
    --primary-500: #8948df;
    --primary-600: #7935cc;
    --neutral-900: #323234;
    --neutral-500: #8e8f95;
    --secondary-700: #66666e;
    --secondary-600: #7e7f86;
    --secondary-200: #cfd0d3;
    --secondary-300: #babbc0;
    --secondary-050: #efeff0;
    --error-700: #a40d3c;
    font-size: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: #fff;
    color: var(--neutral-900);
    font-family: Figtree, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .shell { width: 100%; max-width: 448px; }
  .brand { font-size: 24px; line-height: 36px; font-weight: 600; margin: 0; }
  .logo { margin: 2rem 0; }
  .logo img { width: 200px; height: auto; display: block; }
  .card {
    padding: 24px;
    background: #fff;
    border: 1px solid var(--secondary-050);
    border-radius: 16px;
    box-shadow: 1px 1px 16px 0 rgba(0, 0, 0, 0.08);
  }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 1rem; }
  p { margin: 0 0 0.75rem; }
  .muted { color: var(--neutral-500); }
  .sent-to { font-weight: 500; color: var(--neutral-500); margin-bottom: 1.5rem; }
  label { display: block; font-size: 14px; font-weight: 500; color: var(--secondary-600); margin-top: 0.75rem; }
  input, select {
    width: 100%;
    min-height: 40px;
    margin-top: 0.25rem;
    padding: 8px 12px;
    font: inherit;
    font-size: 14px;
    color: var(--secondary-700);
    background: #fff;
    border: 1px solid var(--secondary-200);
    border-radius: 8px;
  }
  select { cursor: pointer; }
  input::placeholder { color: var(--secondary-300); }
  input:focus-visible, select:focus-visible { outline: 1px solid #92939b; }
  .otp { display: flex; justify-content: center; gap: 8px; margin-top: 0.5rem; }
  .otp input {
    width: 40px; height: 40px; min-height: 40px; margin-top: 0; padding: 0;
    text-align: center; font-size: 18px;
  }
  .otp input:focus-visible { outline: 1px solid var(--primary-400); }
  hr { border: none; border-top: 1px solid var(--secondary-050); margin: 1.75rem 0; }
  button {
    width: 100%;
    min-height: 36px;
    margin-top: 2rem;
    padding: 8px 16px;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--primary-400);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { background: var(--primary-500); }
  button:active { background: var(--primary-600); }
  .error { color: var(--error-700); font-size: 12px; margin: 1rem 0 0; }
  .empty { color: var(--neutral-500); font-size: 12px; margin: 1.5rem 0 0; }
  @media (min-width: 640px) { .otp input { width: 48px; height: 48px; min-height: 48px; font-size: 20px; } }
</style>
</head>
<body><main class="shell">
  <p class="brand">Welcome back to</p>
  <div class="logo"><img src="${LOGO_URL}" alt="Superfans" width="200"></div>
  <div class="card">${body}</div>
</main></body>
</html>`;
```

- [ ] **Step 2: Restyle the email screen**

```ts
export const renderEmailForm = (error?: string): string =>
  page(`
  <h1>Log in to Hermes</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/request-otp">
    <label>Email
      <input name="email" type="email" placeholder="name@email.com" required autofocus
             autocomplete="username">
    </label>
    <button type="submit">Login</button>
  </form>`);
```

- [ ] **Step 3: Replace the code screen's single field with eight boxes**

The Dashboard uses eight boxes (`OTPInput length={8}`) and the real codes are
eight digits. The boxes post through one hidden `name="otp"` field, so the
server side is untouched. Keep the words `one-time code` in the label — two
tests assert that phrase.

```ts
/** Eight boxes joined into one hidden field, matching the Dashboard's OTPInput length={8}. */
export const renderOtpForm = (email: string, error?: string): string =>
  page(`
  <h1>Sign In</h1>
  <p class="muted">Enter the verification code sent to:</p>
  <p class="sent-to">${escapeHtml(email)}</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/verify-otp">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <input type="hidden" name="otp" id="otp-value">
    <label>One-time code</label>
    <div class="otp">
      ${Array.from(
        { length: 8 },
        (_, index) =>
          `<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="Digit ${
            index + 1
          }"${index === 0 ? " autofocus" : ""}>`
      ).join("\n      ")}
    </div>
    <button type="submit">Verify OTP</button>
  </form>
  <script>
    const boxes = Array.from(document.querySelectorAll(".otp input"));
    const target = document.getElementById("otp-value");
    const sync = () => { target.value = boxes.map((box) => box.value).join(""); };
    boxes.forEach((box, index) => {
      box.addEventListener("input", () => {
        box.value = box.value.replace(/\\D/g, "").slice(0, 1);
        sync();
        if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
      });
      box.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !box.value && index > 0) boxes[index - 1].focus();
      });
      box.addEventListener("paste", (event) => {
        event.preventDefault();
        const digits = (event.clipboardData.getData("text") || "").replace(/\\D/g, "").slice(0, boxes.length);
        digits.split("").forEach((digit, offset) => { boxes[offset].value = digit; });
        sync();
        boxes[Math.min(digits.length, boxes.length - 1)].focus();
      });
    });
  </script>`);
```

Note the doubled backslashes in `/\\D/g` — they are inside a TypeScript template
literal, so the emitted HTML carries `/\D/g`. Verify that in the built output,
not just by reading the source.

- [ ] **Step 4: Restyle the picker's heading and the search box's label; change nothing else about it**

In `renderStorePicker`, change the heading from `Pick a store` to
`Select a Store` and mark the empty note as muted. Leave `storeLabel`,
`storeOption`, `storeDropdown`, the `choosable` calculation, the `emptyNote`
wording, and the `<hr>` placement exactly as they are.

In `searchBox`, keep the action, the input name, and the `required`/`value`
attributes identical; the styling comes from the stylesheet.

- [ ] **Step 5: Run the covering tests**

Run: `npx vitest run test/login/loginServer.test.ts`

If a test fails only because it asserted the old `Pick a store` heading, update
that assertion to the new copy. If any test fails for a structural reason — a
missing `name="otp"`, a changed `<option>` shape, a missing
`action="/search-stores"` — that is the restyle breaking behaviour, not a stale
assertion: fix the markup rather than the test.

- [ ] **Step 6: Typecheck and the full suite**

Run: `npm run typecheck` then `npx vitest run`
Expected: clean; 137 passing + 1 platform-skipped, apart from the known
`test/logging.test.ts` stderr line.

- [ ] **Step 7: Build and confirm each screen renders**

```bash
npm run build
node dist/login.js &
# use the port it prints on stderr:
curl -s http://127.0.0.1:<port>/ | grep -cE 'Welcome back to|name="email"|Figtree'
curl -s -X POST http://127.0.0.1:<port>/request-otp \
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}' \
  | grep -cE 'maxlength="1"'
```

The first should report 3, the second 8. Kill the process afterwards. Paste both
outputs. **Do not complete a real login** — it emails a code to a real address.

- [ ] **Step 8: Commit**

```bash
git add src/login/loginPage.ts test/login/loginServer.test.ts
git commit -m "feat: restyle the login screens to match the Dashboard"
```
