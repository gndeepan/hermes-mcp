# hermes-mcp — design spec

Date: 2026-09-08
Status: approved, pre-implementation

## What this is

A new standalone repo, `hermes-mcp`, that exposes a curated set of Hermes Atlas
backend REST endpoints as MCP tools over stdio. Its primary consumer
is `ai-server` (the Python/FastAPI/Pydantic AI execution layer) — Pydantic AI
has native MCP client support, so agents can gain new Hermes capabilities by
registering a tool in their `agent.yaml` allowlist instead of ai-server hand-coding
a new method on `hermes_client.py` every time. It can also be registered with
Claude Code / other MCP clients for interactive use.

This repo does not modify `ai-server`, `dashboard`, or `vajro-custom-blocks-sdk`.
Wiring `hermes-mcp` into ai-server's agent runtime is an ai-server-side follow-up,
out of scope here.

## Why (context that shaped this)

- Hermes Atlas (`https://hermes-atlas.vajro.com`, OpenAPI 3.0.1 at `/v3/api-docs`)
  is a ~272-endpoint, 52-domain REST API (Spring auto-generated CRUD controllers;
  operation summaries are generic "Read"/"Update"/"Delete", not documented).
- `ai-server/src/ai_server/context/hermes_client.py` already calls a handful of
  these endpoints (active theme, custom blocks CRUD) carrying **the end user's
  own token** per request — `UserContext` is built fresh per request and never
  cached, so one user's token can never serve another's request. This is the
  load-bearing security property and `hermes-mcp` must preserve it exactly.
- `ai-server/docs/architecture.md` commits explicitly to a **tool allowlist per
  agent** and **"no filesystem or arbitrary-network tool in v1."** A generic
  "call any Hermes endpoint" tool would violate that stated posture, so tool
  exposure must be curated, not generated wholesale from the spec.
- The existing `vajro-custom-blocks-sdk/mcp` server is the nearest sibling
  convention (Node/TS, esbuild bundle, structured stderr logging, eager startup
  config validation, vitest) — but it only ever *describes and validates*, never
  executes. `hermes-mcp` is different in kind: it calls a live backend that
  mutates real merchant data, so credential handling and error surfacing are
  first-class design concerns here in a way they weren't for the SDK MCP.

## Non-goals for v1

- Not a 1:1 codegen of all 272 endpoints.
- Not a generic REST proxy / "call any endpoint" tool.
- Not auto-discovering new tools as the live OpenAPI spec changes — the set
  of exposed operations is still only ever what's named in the allowlist.
  Live sync (below) keeps an allowlisted tool's *schema* current; it never
  adds or removes which operations are exposed.
- Not responsible for wiring itself into ai-server's agent registry.
- Not responsible for issuing or refreshing Hermes tokens — it only forwards
  a token it's handed.

## Architecture

```
claude mcp add hermes-mcp -e HERMES_ACCESS_TOKEN=... -e HERMES_STORE_ID=... -- node dist/server.js
                          │
                          ▼  stdio, one process per client/session
                     hermes-mcp
                          │
                          ▼
                 Hermes Atlas REST
```

- **Transport**: stdio, via `@modelcontextprotocol/server/stdio`'s
  `serveStdio` — **the same transport `vajro-custom-blocks-sdk/mcp` already
  uses**, not Streamable HTTP. There is no hosted service to run this
  against yet, so a locally-spawned process (registered with `claude mcp
  add`, or spawned by ai-server as a subprocess for one agent run) is the
  right default, matching the existing sibling MCP exactly. This is a
  reversal of an earlier draft of this spec, which chose Streamable HTTP for
  a hypothetical persistent multi-tenant service — revisit that choice if
  and when `hermes-mcp` actually gets deployed as a shared service ai-server
  calls over the network, since the credential model below is deliberately
  process-scoped, not request-scoped, and assumes one process serves one
  identity.
- **Credential flow**: `HERMES_ACCESS_TOKEN` and `HERMES_STORE_ID` are read
  once from the environment at process startup (config, validated eagerly
  like every other setting) — **one hermes-mcp process serves exactly one
  Hermes identity for its whole life**, which is the natural credential
  boundary for stdio (one process per client/session), just as `UserContext`
  in `hermes_client.py` is the natural boundary per HTTP request for that
  Python service. Never logged, never sent anywhere but as the
  `Authorization`/`X-Store-Id` headers on calls to Hermes. `tools/list`
  works with no credentials configured; an actual tool call with no
  credentials configured returns a `MISSING_CREDENTIALS` tool error before
  any Hermes call is attempted. A 401/403 from Hermes is surfaced as-is:
  Hermes is the sole authority on what the token may do, `hermes-mcp` never
  second-guesses it.
- **Tool registry** (`src/registry/endpoints.ts`): the single source of
  truth. Each entry names one Hermes operation — method, path template, a
  curated tool name and description (never the raw Spring "Read"/"Update"
  summary), and a Zod input schema for path/query/body params.
- **Adding a tool** is one entry in `src/registry/endpoints.ts` (tool name,
  method, path template, description) plus running the tests — the same
  resolver (`src/registry/schemaFromOpenApi.ts`) backs the startup compile,
  the live refresh below, and a test that compiles every allowlisted entry
  against the checked-in snapshot, so a bad entry fails a test rather than
  needing a human to eyeball generated output. Every exposed operation
  remains a deliberate, reviewed choice — never a wholesale dump of all 272.
- **Live OpenAPI sync (runtime)**: Hermes's contract for an already-allowlisted
  operation can change without a `hermes-mcp` deploy (a new optional field, a
  changed enum, a renamed param), so the server does not run forever on the
  schema snapshot it started with. On startup, and again every
  `HERMES_OPENAPI_REFRESH_INTERVAL_S` (default 900s), the server fetches the
  live spec from `HERMES_OPENAPI_DOCS_URL` (default
  `https://hermes-atlas.vajro.com/v3/api-docs`, the same environment as
  `HERMES_BASE_URL`'s default) and, for every allowlisted
  entry, rebuilds its Zod input schema from the fresh spec via the same
  resolver function the codegen script uses (`src/registry/schemaFromOpenApi.ts`
  — one implementation, used offline and at runtime, so they can't drift from
  each other). The rebuilt schema map swaps in atomically; in-flight tool
  calls finish against whichever schema they started with. A tool call newly
  arriving after a refresh is validated against the refreshed schema.
  - **Re-advertising**: refreshing the registry is only half the job — the MCP
    server holds whatever schema each tool was registered with, so every
    refresh (background or on demand) also pushes the changed schemas back
    through the retained `RegisteredTool` handles via
    `update({ paramsSchema })`, which reassigns the input schema the SDK
    validates against and notifies clients with `tools/list_changed`. Without
    that step a refresh changes nothing observable: `tools/list` keeps
    advertising the startup schema and a newly *required* param is stripped by
    validation before it can reach the request builder.
  - **Startup fallback**: if the live fetch fails at startup (network error,
    non-200, malformed spec), the server logs a warning and starts anyway
    using the checked-in snapshot's schemas — an unreachable docs endpoint
    must never prevent the server from starting.
  - **Steady-state fallback**: if a background refresh fails, the server logs
    a warning and keeps serving the last-known-good schemas. It never crashes
    or empties the tool list because of a transient fetch failure.
  - **Missing operation**: if an allowlisted path+method is no longer present
    in a freshly fetched spec, that one tool logs an error and keeps its
    last-known-good schema (other tools refresh normally) — a removed
    endpoint degrades one tool, not the whole server.
- **Tool naming**: `hermes_` prefix (`hermes_get_theme`,
  `hermes_list_custom_blocks`, ...) so tools namespace cleanly next to the
  existing `sdk_*` tools from `vajro-custom-blocks-sdk/mcp` when both servers
  are registered with the same client.
- **`src/hermesClient.ts`**: thin `fetch`-based wrapper built once per
  process from the configured credentials (mirrors the Python
  `HermesClient`/`UserContext` split, just at process granularity instead of
  request granularity). Unwraps Hermes's `{"data": ...}` envelope. Maps
  transport errors and 401/403/404/4xx/5xx to typed errors that a `wrap()`
  layer turns into structured, visible MCP tool results — a Hermes rejection
  is a legitimate answer the agent needs to see (not hidden behind a
  correlation id the way a genuinely unexpected internal fault is).
- **Observability**: one `wrap()` around every tool handler for timing and
  structured JSON logs to stderr — **stdout is the MCP transport**, so
  `console.log`/`process.stdout.write` anywhere under `src/` is a hard
  failure, exactly as in the SDK MCP. Request/response bodies logged only at
  `debug`; **tokens are never logged at any level**, full stop — the logger
  itself redacts any field shaped like one as a second line of defence,
  stricter than the SDK MCP's "secrets at debug only" rule, because this is
  live customer data, not authoring-time payloads.
- **Config**: env vars (`HERMES_MCP_LOG_LEVEL`, `HERMES_BASE_URL`,
  `HERMES_OPENAPI_DOCS_URL`, `HERMES_OPENAPI_REFRESH_INTERVAL_S`,
  `HERMES_ACCESS_TOKEN`, `HERMES_STORE_ID`), validated eagerly at startup —
  an invalid value fails immediately naming the variable and allowed
  values, so a misconfigured server never starts and behaves oddly.
  `HERMES_BASE_URL` (where tool calls go — host root, e.g.
  `https://hermes-atlas.vajro.com`) and `HERMES_OPENAPI_DOCS_URL` (where
  the spec is fetched from) are separate settings on separate hosts/paths
  and must not be derived from one another — but their defaults point at the
  same environment, and a deployment should keep them there: refreshing tool
  schemas from one environment while issuing tool calls against another
  serves schemas for a host nobody is talking to. `HERMES_ACCESS_TOKEN` and
  `HERMES_STORE_ID` must be set together or not at all.

## v1 tool scope

Deliberately small — mirrors what `hermes_client.py` already hand-codes plus
its nearest useful neighbors, so this is an immediate net win without trying
to cover all 52 domains on day one. Every other domain stays unexposed until
an agent actually needs it; adding one later is cheap (allowlist entry +
regenerate + review), never a redesign.

| Domain | Tools |
|---|---|
| Themes | `hermes_get_active_theme`, `hermes_get_theme`, `hermes_list_theme_versions` |
| Custom blocks | `hermes_list_custom_blocks`, `hermes_get_custom_block`, `hermes_create_custom_block`, `hermes_update_custom_block` |
| Widgets | `hermes_get_widget`, `hermes_update_widget` |
| Pages | `hermes_list_pages` (pages of a theme), `hermes_get_page` |

## Repo & tooling

- New standalone repo at `SUPERFANS/hermes-mcp`, registered as a folder in
  `Superfans.code-workspace`.
- Node 20, TypeScript, esbuild bundle (same toolchain choice as
  `vajro-custom-blocks-sdk/mcp`, for convention consistency even though this
  server is architecturally different in kind).
- vitest for tests: unit tests per tool with a mocked/injected Hermes
  client; an integration test driving a real server over
  `InMemoryTransport` (the same pattern `vajro-custom-blocks-sdk/mcp`'s own
  `integration.test.ts` uses); an explicit test that a tool call with no
  credentials configured never reaches Hermes.
- `claude mcp add hermes-mcp --scope user -e HERMES_MCP_LOG_LEVEL=info
  -e HERMES_ACCESS_TOKEN=<token> -e HERMES_STORE_ID=<id> -- node
  "/absolute/path/to/hermes-mcp/dist/server.js"` for interactive
  registration — identical in shape to how the SDK MCP is registered today.

## Hard constraints (mirrors the SDK MCP's four, adapted for a server that
executes real calls)

1. Never write to stdout — stdout is the MCP transport; the logger writes to
   stderr only.
2. Never store a credential outside the process it was configured for — one
   `hermes-mcp` process serves exactly one Hermes identity, read once from
   the environment at startup, never refreshed or overwritten mid-process.
3. Never expose a Hermes operation that isn't a named entry in
   `src/registry/endpoints.ts` — no dynamic/generic path construction from
   caller input.
4. Never log a token, at any log level.
