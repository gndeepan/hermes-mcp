# hermes-mcp — auth, tracing & refresh extension

Date: 2026-09-08
Status: approved, pre-implementation
Extends: `2026-09-08-hermes-mcp-design.md` (the base spec — read that first; this
document only covers what it adds or changes)

## What this adds

Four things, all requested together because they share the same two files in the
base design (`src/config.ts`'s credential handling and `src/tools/index.ts`'s
`wrap()`):

1. A local HTML login page + short-lived local server, run as a **separate CLI
   command** (`node dist/login.js`), that authenticates against Hermes's real Web
   login endpoint and persists a token.
2. Token lifecycle management: the persisted token is used for every MCP tool
   call, refreshed transparently before it expires, and refreshed-and-retried once
   on an unexpected 401 — "avoid unnecessary re-auth" from the request.
3. Tracing: a correlation id per tool call threaded through the logs already built
   in the base spec, so a developer can follow one call end-to-end in stderr.
4. `hermes_refresh_openapi`, a 12th MCP tool that manually triggers the schema
   refresh the base spec already built for the background interval.

## Why this shape (decisions made and why)

- **Login is a separate CLI command, not an MCP tool.** hermes-mcp is stdio —
  there is no HTTP listener for a browser to talk to, and an MCP tool call is the
  wrong protocol for "block waiting on a human filling out a browser form."
  Matches `gh auth login` / `claude login`: a human runs it once, interactively,
  outside the agent's tool-calling loop.
- **The persisted token is a file under the OS user-config dir, not a keychain.**
  A native keychain module is real install/build risk on Windows and in CI for a
  dev-facing internal tool; a plain JSON file under
  `env-paths` (`%APPDATA%\hermes-mcp\credentials.json` on Windows,
  `~/.config/hermes-mcp/credentials.json` on Linux, `~/Library/Application
  Support/hermes-mcp/credentials.json` on macOS) is simple, has no native
  dependency, and is never inside the repo.
- **Only the Web login (`POST /api/v1/auth/web`) is in scope, and it is an
  email + one-time-code flow — not email + password.** This was corrected after
  reading the Dashboard's own implementation (`packages/api/services/auth.ts`),
  which is the reference for what this endpoint actually expects:
  1. `POST /api/v1/otp/email/send` with `{ email }` and **no** `Authorization`
     header mails a one-time code.
  2. `POST /api/v1/auth/web` with an **empty JSON body** and
     `Authorization: Basic base64(email + ":" + otp)` returns the token pair.
     The Basic-auth password slot carries **the OTP code**, not a password, and
     there is no `domain` field — the Dashboard sends `{}`. Hermes has no
     email+password login endpoint at all.
  Hermes's other login mechanisms stay out of scope: `/api/v1/auth/mobile` and
  `/api/v1/auth/shopify-session` serve the mobile app and the embedded Shopify
  flow, and `/api/v1/otp-login/*` is shopper-facing (its `verify-otp` requires
  `phone` and returns a `customerAccessToken`, not an operator token) — none fit
  hermes-mcp's users, who are the same population the Dashboard's login serves.
- **Store selection is confirmed against the login response, then registered
  server-side.** The `stores[]` array comes back inline from `/api/v1/auth/web`,
  so no separate "list my stores" call is needed. Once a store is chosen,
  `POST /api/v1/auth/stores/login` (empty body, `X-Store-Id` header) records the
  choice, mirroring what the Dashboard's store switcher does. Its response body
  is not inspected — only success or failure matters — and a failure aborts the
  login rather than persisting a store Hermes did not accept.
- **The static `HERMES_ACCESS_TOKEN`/`HERMES_STORE_ID` env vars from the base
  spec keep working.** They become a fallback when no `credentials.json` exists,
  not a removed feature — CI or a one-off script that doesn't want an interactive
  login still has a path.

## Non-goals

- Not building UI for any login mechanism other than the Web login.
- Not a full OTel tracing pipeline — a correlation id through the existing
  structured logger is enough for a dev-facing tool; ai-server's own OTel work
  (`ai-server/docs/architecture.md` §7) is a separate, larger initiative this does
  not need to match.
- Not storing the token in an OS keychain.
- Not letting `hermes_refresh_openapi` (or anything else) change *which*
  operations are allowlisted — same non-goal as the base spec: it refreshes a
  schema, never adds or removes a tool.

## Architecture

```
node dist/login.js [--store <id>]
      │
      ▼  starts a local HTTP server on 127.0.0.1:<ephemeral port>, opens the
      │  default browser to it
 screen 1: email
      │
      ▼  POST /api/v1/otp/email/send  { email }   (no Authorization header)
 Hermes mails a one-time code
      │
      ▼
 screen 2: the code
      │
      ▼  POST /api/v1/auth/web   body {}   Authorization: Basic base64(email:otp)
 Hermes Atlas
      │
      ▼  200 { userId, accessToken, refreshToken, expiresAt, stores[], isAdmin }
 stores.length === 1 ? that store
 stores.length  > 1  ? screen 3 shows a picker (name + domain per store)
      │                 (or: --store <id> skips the picker, still validated)
      ▼  POST /api/v1/auth/stores/login   body {}   X-Store-Id: <chosen id>
      │  (registers the choice; a failure aborts rather than persisting)
      ▼
 credentials.json under the OS config dir; local server shuts down; CLI exits 0


node dist/server.js   (trigger unchanged from the base spec)
      │
      ▼  TokenManager.load(): reads credentials.json;
      │  falls back to HERMES_ACCESS_TOKEN/HERMES_STORE_ID env vars if absent
      ▼
 every Hermes call: TokenManager.getValidCredentials()
      │  expiresAt within 60s (or already past)?
      │    → POST /api/v1/auth/refresh { refreshToken } → persist the new pair
      │  Hermes still returns 401 despite a fresh-looking token?
      │    → refresh once, retry the call once, then surface UNAUTHENTICATED
      ▼
 Hermes Atlas REST
```

## Components

### `src/auth/tokenStore.ts`

Reads and writes the persisted credentials file. Shape on disk:

```ts
interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms, matches Hermes's WebTokenResponseDto.expiresAt
  storeId: string;
}
```

`env-paths` (a small, pure-JS, no-native-dependency package) resolves the
OS-appropriate config directory; the store creates it if missing
(`fs.mkdirSync(dir, { recursive: true })`). A missing or unparsable file is not an
error — it means "no persisted login yet," and callers fall back to env vars.

**`expiresAt` units are not pinned down by the OpenAPI spec** — it's declared
only as `integer`, with no format hint, and could plausibly be epoch seconds or
epoch milliseconds. `tokenStore` normalizes on write: a value below
`10_000_000_000` (below roughly the year 2286 in seconds, comfortably above any
real epoch-ms value's low bound) is treated as seconds and multiplied by 1000;
`StoredCredentials.expiresAt` on disk and in memory is always epoch
milliseconds after that normalization, so every other component (`tokenManager`'s
60s check, tests) works against one consistent unit regardless of which one
Hermes actually sends. Confirm the real shape against a live login response
during Task implementation and adjust the threshold constant if needed — it is
isolated to this one normalization function.

### `src/auth/hermesAuth.ts`

Four thin `fetch` wrappers against `HERMES_BASE_URL` (the same setting the base
spec's `HermesClient` uses):

- `sendEmailOtp(baseUrl, email): Promise<void>` — `POST /api/v1/otp/email/send` with body `{ email }` and no `Authorization` header.
- `webLogin(baseUrl, email, otp): Promise<WebLoginResult>` — `POST /api/v1/auth/web` with an empty body and `Authorization: Basic <base64(email:otp)>`.
- `storeLogin(baseUrl, accessToken, storeId): Promise<void>` — `POST /api/v1/auth/stores/login` with an empty body, `Authorization: Bearer <accessToken>` and `X-Store-Id: <storeId>`. Response body unused.
- `refreshAccessToken(baseUrl, refreshToken): Promise<RefreshResult>` — `POST /api/v1/auth/refresh` with body `{ refreshToken }`. `refreshAccessToken` carries the `storeId` over unchanged from the credentials it was given (Hermes's response doesn't re-state it — a refresh doesn't change which store you act as).

The shared `postJson` helper deliberately omits the request body from the error
it throws on a non-2xx response: on the login call that body is empty, but the
`Authorization` header carries the OTP, so nothing about the request is echoed
into an error or a log.

### `src/auth/tokenManager.ts`

Replaces the base spec's static `Credentials | null` in `ToolContext`. Owns one
in-memory `StoredCredentials | null`, loaded once at server startup from
`tokenStore` (or env vars). `getValidCredentials(): Promise<Credentials>`:

1. No credentials loaded at all → throw `MissingCredentialsError` (same error the
   base spec already defines and `toToolResult` already maps).
2. `expiresAt` more than 60s away → return the current credentials unchanged.
3. Otherwise → call `refreshAccessToken`, persist the result via `tokenStore`,
   update the in-memory copy, return it.

`HermesClient.request()` (base spec, Task 4) gains one call site: on catching its
own `HermesUnauthenticatedError`, if this is the *first* 401 for this call, ask
`TokenManager` to force a refresh (bypassing the 60s check) and retry the request
exactly once before letting the error propagate. This lives in the tool `wrap()`
layer (Task 8), not inside `HermesClient` itself, so `HermesClient` stays a pure
per-call transport and the retry policy stays in one place next to the other
call-outcome handling.

### `src/login/loginPage.ts`, `src/login/loginServer.ts`, `src/login.ts`

- `loginPage.ts` exports plain functions returning HTML strings for the three
  screens (email form; one-time-code form; store picker) plus the closing page —
  no templating library, no client-side framework. Store names come from Hermes
  and are HTML-escaped.
- `loginServer.ts` is a plain `node:http` server (this is the one place in the
  repo an HTTP listener is correct — it is not the MCP transport, it is a
  throwaway local server for one login, gone before the MCP server ever starts).
  Routes: `GET /` (email form), `POST /request-otp` (calls `sendEmailOtp`, returns
  the code form), `POST /verify-otp` (calls `webLogin`, then either the store
  picker if `stores.length > 1`, or straight through to registering and
  persisting a single store), `POST /select-store` (validates the picked id
  against the login response's `stores[]`, calls `storeLogin`, persists, returns
  the closing page). Binds to an OS-assigned ephemeral port on `127.0.0.1` only.
  A chosen store is always registered with `storeLogin` before anything is
  persisted, on every path (single-store, `--store`, and picker alike) — one code
  path rather than three, since hermes-mcp acts as exactly one store for its whole
  process lifetime.
- `login.ts` is the CLI entrypoint (a second `bin` entry: `hermes-mcp-login`):
  parses `--store <id>` if given, starts `loginServer`, opens the default browser
  to it (`child_process.exec` of `start` / `open` / `xdg-open` by platform — no
  new dependency), waits for the server to signal completion, then exits.

### `hermes_refresh_openapi` (new 12th tool, in `src/tools/index.ts`)

No input. Calls the exact `fetchOpenApiDoc` + `registry.refresh()` the base spec
already built for the background interval, and returns which of the 11 tool
schemas actually changed (compare each `CompiledEndpoint.paramLocations`
before/after) versus which failed to refresh (already logged by `refresh()`
itself). Purely additive — it does not replace the interval, which keeps running.

### Tracing

`wrap()` (base spec, Task 8) generates one correlation id per call (same
`randomBytes(4).toString("hex")` already used in `errors.ts`'s unexpected-error
path) and is the *only* place that logs — consistent with the base spec's
existing principle that all observability lives in `wrap()`, once.
`HermesClient` itself stays exactly as Task 4 built it: no logger dependency, no
`traceId` parameter, unchanged. `wrap()` already computes the method and
substituted path before calling the client (it has to, to make the call), so it
logs `{ tool, traceId, method, path, durationMs, outcome }` at `debug` right
before the call and `{ tool, traceId, durationMs, outcome }` at `info` after —
on failure, the caught error's own type/status (e.g. `HermesRejectedError.status`)
is already in the log line via the existing `toToolResult`/error-mapping path.
Enough to grep one call's full path through stderr by its id, with zero change
to `HermesClient`. Tokens are still never logged, at any level, per the base
spec's hard constraint #4.

## Error handling

- `credentials.json` missing/corrupt → treated as "logged out," not a crash;
  `MissingCredentialsError` on the first tool call that needs Hermes, same as the
  base spec's existing behavior with no env vars set.
- `webLogin`/`refreshAccessToken` network failure or non-200 → the login CLI
  prints the error and exits non-zero; the browser page shows a plain error
  message with no retry loop (re-running the CLI is the retry).
- A refresh that itself gets a 401 (refresh token expired or revoked) → surfaced
  to the tool caller as `MISSING_CREDENTIALS` with a message naming that
  re-running `hermes-mcp-login` is needed — not `UNAUTHENTICATED`, because the
  fix is different (no token will work until a fresh login, versus a transient
  rejection).

## Testing

- `tokenStore`: round-trips a written file; returns `null` for a missing file;
  returns `null` (not a throw) for a corrupt/unparsable file.
- `tokenManager`: returns credentials unchanged when `expiresAt` is far away;
  refreshes and persists when within 60s; throws `MissingCredentialsError` when
  nothing is loaded and no env vars are set; a fake clock drives the "within 60s"
  cases deterministically.
- `hermesAuth`: `sendEmailOtp` posts `{ email }` and sends no `Authorization`
  header; `webLogin` sends `Basic base64(email:otp)` with an empty body and maps
  the response; `storeLogin` sends the `X-Store-Id` header with an empty body;
  `refreshAccessToken` likewise. One test asserts the OTP never reaches a thrown
  error.
- `loginServer`: driven with real `fetch` calls against `127.0.0.1:<port>` (no
  browser automation) — `GET /` returns the email form; `POST /request-otp`
  returns the code form; `POST /verify-otp` with a mocked Hermes response returns
  the picker for multiple stores or registers-and-persists for one;
  `POST /select-store` validates membership, registers, and persists via an
  injected `tokenStore`; a `storeLogin` failure persists nothing.
- `wrap()`'s 401-retry-once: a fake `HermesRequester` that fails with
  `HermesUnauthenticatedError` on the first call and succeeds on the second,
  proving exactly one retry (a third call would mean the retry policy loops).
- `hermes_refresh_openapi`: reports a changed tool when the injected doc differs
  from the snapshot, using the same fixture-doc pattern as
  `schemaRegistry.test.ts`.
- Tracing: a call's `info` and `debug` log lines share the same `traceId`.

## Impact on the base spec's plan (`docs/superpowers/plans/2026-09-08-hermes-mcp-implementation.md`)

Nothing has been implemented yet, so the plan is revised in place rather than
layered:

- **Task 1** (`config.ts`): `credentials` stops being resolved eagerly inside
  `loadConfig`. `loadConfig` keeps parsing `HERMES_ACCESS_TOKEN`/`HERMES_STORE_ID`
  as before (still validated together-or-neither) but now hands them to
  `TokenManager` as the env-var fallback rather than being the credential itself.
  the field on `HermesMcpConfig` is only ever used to seed a `TokenManager`.
- **Task 4** (`HermesClient`): unchanged transport/error-mapping logic; gains
  nothing new itself — the refresh-and-retry lives in `wrap()`, not here, so this
  task's tests and implementation stand as written.
- **Task 8** (`tools/index.ts`): `ToolContext.credentials: Credentials | null`
  becomes `ToolContext.tokenManager: TokenManager`; `wrap()` calls
  `await ctx.tokenManager.getValidCredentials()` instead of reading a static
  field, and gains the 401-retry-once. The `hermes_refresh_openapi` tool is
  registered alongside the other 11.
- **Task 9** (`server.ts`): builds a `TokenManager` (loading `credentials.json` or
  falling back to `config`'s env-var-sourced credentials) instead of passing
  `config.credentials` straight through.
- **New tasks** (numbering continues from the existing plan's Task 10): token
  store, hermesAuth client, TokenManager, the login CLI + local server + HTML
  pages, tracing IDs, and the `hermes_refresh_openapi` tool — each with its own
  TDD steps, inserted before the existing Task 10 (build script/README), since
  the README needs to document the login command too.
