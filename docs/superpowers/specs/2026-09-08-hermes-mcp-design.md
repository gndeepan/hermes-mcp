# hermes-mcp — design spec

Date: 2026-09-08
Status: approved, pre-implementation

## What this is

A new standalone repo, `hermes-mcp`, that exposes a curated set of Hermes Atlas
backend REST endpoints as MCP tools over Streamable HTTP. Its primary consumer
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
Pydantic AI agent (ai-server)  ──MCP over Streamable HTTP──▶  hermes-mcp
     (or: Claude Code / other MCP client)                        │
   sets Authorization + X-Store-Id per request                   │
   (the end user's own token — never hermes-mcp's own)            │
                                                                   ▼
                                                          Hermes Atlas REST
```

- **Transport**: Streamable HTTP (`@modelcontextprotocol/sdk`'s
  `StreamableHTTPServerTransport`), a persistent Node service — not stdio.
  A shared, multi-tenant server needs per-call credentials, which stdio (one
  spawned process per session) makes awkward; HTTP lets every request carry
  its own headers cleanly.
- **Credential flow**: every tool-call HTTP request must carry
  `Authorization: Bearer <token>` and `X-Store-Id: <id>`, set by the MCP
  client (ai-server, using the same end-user token it already receives from
  the Dashboard). `hermes-mcp` reads these two headers per request,
  forwards them unchanged to Hermes, and **never stores them** at module or
  process scope — reconstructed per request, exactly like `UserContext` in
  `hermes_client.py`. Missing/malformed headers → a 400-shaped tool error
  returned before any Hermes call is attempted. A 401/403 from Hermes is
  surfaced as-is: Hermes is the sole authority on what the token may do,
  `hermes-mcp` never second-guesses it.
- **Tool registry** (`src/registry/endpoints.ts`): the single source of
  truth. Each entry names one Hermes operation — method, path template, a
  curated tool name and description (never the raw Spring "Read"/"Update"
  summary), and a Zod input schema for path/query/body params.
- **Codegen** (`scripts/generate-schemas.mjs`, dev-time only): reads the
  checked-in OpenAPI snapshot (`openapi/hermes-api-docs.json`) plus the
  allowlist in `endpoints.ts`, and emits typed Zod shapes into
  `src/generated/` purely for editor/type-checking support while authoring a
  new allowlist entry. This keeps adding a tool to "one allowlist entry +
  regenerate," while every exposed operation remains a deliberate, reviewed
  choice — never a wholesale dump of all 272 operations.
- **Live OpenAPI sync (runtime)**: Hermes's contract for an already-allowlisted
  operation can change without a `hermes-mcp` deploy (a new optional field, a
  changed enum, a renamed param), so the server does not run forever on the
  schema snapshot it started with. On startup, and again every
  `HERMES_OPENAPI_REFRESH_INTERVAL_S` (default 900s), the server fetches the
  live spec from `HERMES_OPENAPI_DOCS_URL` (default
  `https://hermes-atlas.vajro.com/v3/api-docs`) and, for every allowlisted
  entry, rebuilds its Zod input schema from the fresh spec via the same
  resolver function the codegen script uses (`src/registry/schemaFromOpenApi.ts`
  — one implementation, used offline and at runtime, so they can't drift from
  each other). The rebuilt schema map swaps in atomically; in-flight tool
  calls finish against whichever schema they started with. A tool call newly
  arriving after a refresh is validated against the refreshed schema.
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
- **`src/hermesClient.ts`**: thin fetch/axios wrapper, one per-request
  instance constructed from the incoming headers (mirrors the Python
  `HermesClient`). Unwraps Hermes's `{"data": ...}` envelope. Maps
  transport errors, 401/403/404/5xx to structured MCP tool errors with the
  same shape ai-server's error envelope already uses, so failures aren't a
  new shape for the agent to learn.
- **Observability**: one `wrap()` around every tool handler for timing and
  structured JSON logs to stderr (never stdout — reserved for the MCP
  transport's own framing even though we're on HTTP, kept as a hard rule for
  consistency with the SDK MCP and to avoid ever accidentally polluting a
  future stdio mode). Request/response bodies logged only at `debug`;
  **tokens are never logged at any level**, full stop — stricter than the
  SDK MCP's "secrets at debug only" rule, because this data is live customer
  data, not authoring-time payloads.
- **Config**: env vars (`HERMES_MCP_LOG_LEVEL`, `HERMES_BASE_URL`,
  `HERMES_OPENAPI_DOCS_URL`, `HERMES_OPENAPI_REFRESH_INTERVAL_S`, `PORT`),
  validated eagerly at startup — an invalid value fails immediately naming
  the variable and allowed values, so a misconfigured server never starts
  and behaves oddly. `HERMES_BASE_URL` (where tool calls go, e.g.
  `.../api`) and `HERMES_OPENAPI_DOCS_URL` (where the spec is fetched from,
  host root) are separate settings — they are different hosts/paths across
  environments and must not be derived from one another.

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
- vitest for tests: unit tests per tool with a mocked `HermesClient`; an
  integration test driving a real server over the Streamable HTTP transport;
  an explicit test that a tool call missing `Authorization`/`X-Store-Id`
  never reaches Hermes.
- `claude mcp add --transport http hermes-mcp <url>` for interactive
  registration once a dev instance is running.

## Hard constraints (mirrors the SDK MCP's four, adapted for a server that
executes real calls)

1. Never write to stdout — logger writes to stderr only.
2. Never store a credential outside the lifetime of a single request.
3. Never expose a Hermes operation that isn't a named entry in
   `src/registry/endpoints.ts` — no dynamic/generic path construction from
   caller input.
4. Never log a token, at any log level.
