# OpenAPI refresh

## What it is for

Hermes's tools are not hand-written. Each one's **input schema** — its
parameter names, types, enums, descriptions and which of them are required — is
compiled from Hermes's own OpenAPI document at
`config.openApiDocsUrl`. Refresh recompiles those schemas from the live
document without restarting the server.

It exists because Hermes ships independently of this server. When Hermes adds a
required query parameter to `GET /api/v1/widgets/{id}`, a server holding the
schema it compiled at boot will keep advertising the old one. The MCP SDK
validates against the advertised schema, so the new parameter is **stripped
from the call before it reaches Hermes** — and the agent gets a rejection for
an argument it did send. Refresh is what closes that window.

There are two paths into it:

| | |
|---|---|
| **Background loop** | `startOpenApiRefreshLoop` — fires once at startup, then every `openApiRefreshIntervalS`. This is the normal path; nobody has to do anything. |
| **`hermes_refresh_openapi`** | A tool, for when waiting for the next tick is too slow. Reach for it when a `hermes_*` call is rejected for an argument you believe is correct. |

Both go through `SchemaRegistry.refresh`, then `syncToolSchemas`, which pushes
changed schemas into the running MCP server and emits `tools/list_changed`.
Refreshing the registry alone changes nothing a client can see — the server
holds whatever schema it was handed at registration.

`hermes_refresh_openapi` is **withheld from every agent toolset** (see the
ai-agent repo's `mcp.json`). It is server maintenance, not merchant work, and
one tenant calling it re-advertises schemas for every tenant.

## What happens when the API definition changes

The three cases are deliberately not symmetric.

### An operation is modified — picked up automatically

A parameter added, removed, retyped, made required or optional, or given a new
description: the schema recompiles, the tool re-advertises, and the next call
validates against the new shape. `hermes_refresh_openapi` returns the tool in
`changed`.

The comparand is the whole rendered JSON Schema, not just parameter locations,
so a change to a type, an enum or a required flag counts as a change. An
earlier version compared locations only and reported "no change" for a
parameter that had switched from string to integer.

**A changed response body is not detected**, and does not need to be. Only
inputs are compiled; responses pass through as whatever Hermes returned.

### An operation is added — deliberately ignored

A new path in the document does **not** become a new tool. `ENDPOINTS` in
`src/registry/endpoints.ts` is the complete set of operations this server will
ever call, and it is the authority boundary: if a path appearing in a document
could grant this server new reach, then whoever can edit that document decides
what an agent may do to a merchant's store.

Adding a tool is a reviewed code change — an entry in `ENDPOINTS` with a
hand-written `description`, because the description is the only thing a calling
model sees before choosing a tool and a generated one-liner is not enough to
pick correctly between a page, a widget and a custom block.

`refreshed` stays at `ENDPOINTS.length` and `changed` stays empty.

### An operation is removed — degrades, and says so

The tool keeps its **last-known-good schema**, stays advertised, and stays
callable. Calls will reach Hermes and fail there, typically with a 404.

This is on purpose. A removal is indistinguishable from a bad fetch — a
truncated document, a spec served from the wrong environment, a deploy caught
mid-roll. Dropping tools on the strength of one unreliable document would break
a working agent for a transient reason. Degrading is the safer failure.

But it must not be silent, which it was until recently: the only trace was an
error line on a server nobody watches. `SchemaRegistry.refresh` now returns the
names it could not compile, and they surface in two places:

- `hermes_refresh_openapi` returns them as **`stale`**, alongside `refreshed`
  and `changed`. A tool in `stale` may fail at Hermes however correctly it is
  called.
- The background loop logs `openapi schema refresh ok` with a `stale` count, so
  "ok" for a server quietly advertising a tool Hermes no longer has is
  distinguishable from ok.

**`stale` is the alerting signal.** A non-zero `stale` that persists across
several refreshes means the document and `ENDPOINTS` genuinely disagree, and
someone needs to either restore the endpoint or remove it from the allowlist.

Note that a path carries every verb on it. Removing `/api/v1/widgets/{id}` takes
`hermes_get_widget` and `hermes_update_widget` stale together.

## Failure modes

| What happens | What the server does |
|---|---|
| Document fetch fails or times out | Logged at `warn`, every schema kept. The loop retries on the next tick. `hermes_refresh_openapi` returns an error result. |
| Document parses but one operation is missing | That tool goes `stale`; the rest refresh. |
| Document is empty or wholly wrong | Every tool goes `stale`; all keep working on last-known-good. |
| Snapshot fails to compile at **startup** | Fails loudly. `SchemaRegistry.fromDocument` throws, because the checked-in snapshot must always compile — a failure there is a bug in this repo's allowlist, not a transient issue. |

The asymmetry between startup and refresh is the point: at startup a broken
schema is our bug and should stop the server; at runtime it is probably someone
else's outage and should not.

## Where this is enforced

- `src/registry/endpoints.ts` — the allowlist, and the reason additions are manual
- `src/registry/schemaRegistry.ts` — `refresh`, and what it returns
- `src/openapiSync.ts` — the background loop
- `src/tools/index.ts` — `hermes_refresh_openapi`, `syncToolSchemas`, the fingerprint
- `test/tools/index.test.ts` — "when Hermes changes its API": one block per case above
