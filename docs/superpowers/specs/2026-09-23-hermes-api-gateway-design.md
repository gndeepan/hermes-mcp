# Hermes API gateway, and the end of the background refresh

**Date:** 2026-09-23
**Status:** proposed, awaiting review

## What this is for

Today the server exposes twelve hand-written tools covering themes, pages,
widgets and custom blocks. That list is a hard boundary: `src/registry/endpoints.ts`
opens by saying it is "the complete set of Hermes operations this server will
ever call... Nothing outside this list is reachable, however the live OpenAPI
document changes."

Hermes has 356 operations. The twelve cover the theme-authoring workflow well
and everything else not at all — a merchant asking "who is this user" or "what
campaigns are running" cannot be answered, and each new question has meant
another hand-written tool and another release.

This design adds a general way in: the agent searches Hermes' own OpenAPI
document for the operation that answers the question, shows the caller its
schema, and can invoke it. It also removes the periodic OpenAPI refresh, which
changes tool schemas underneath a running session for no benefit anyone asked
for.

### Decisions taken before this was written

Four choices were made in conversation and are not reopened here:

1. **The gateway may call anything** — any method, any path in the spec,
   including `POST`, `PUT` and `DELETE`. See *Risk* below; this is a deliberate,
   informed reversal of hard constraint #3.
2. **The spec is fetched once at startup**, with the bundled snapshot as
   fallback. No repeating timer. `hermes_refresh_openapi` stays as the manual
   escape hatch.
3. **The twelve curated tools stay**, and the gateway is described as the
   fallback for what they do not cover.
4. **Discovery and invocation are separate tools**, so the agent can find and
   report a schema without calling anything.

## Risk, stated once

With any-method access the allowlist stops being a safety boundary. Among the
356 reachable operations are `DELETE /api/v1/themes/{id}`,
`POST /api/v1/stores/{id}/refresh-security-code` and
`PUT /api/v1/stores/{id}/firebase/service-account`. A mis-chosen path is no
longer a failed call — it is a destructive one, executed with the caller's own
credentials and therefore fully authorised.

This design does not prevent that, because preventing it is what was declined.
It does three things to make the mistake less likely and more visible:

- discovery and invocation are separate tools, so there is a natural point at
  which an agent can show a human what it is about to do;
- `hermes_call_api` requires the caller to restate the method, so an agent that
  found a `GET` and meant to call a `GET` cannot drift into a `DELETE` by
  passing the wrong identifier alone;
- every gateway invocation is logged at `warn` when the method is not `GET`,
  naming method and path, so a destructive call is greppable after the fact.

What it will not do is ask for confirmation. This server has no channel to a
human — it answers a tool call. Confirmation belongs to the client, and the tool
descriptions say so explicitly.

## Part 1 — Removing the background refresh

### What goes

`startOpenApiRefreshLoop` currently fires an immediate refresh and then one
every `openApiRefreshIntervalS` (default 900s), re-advertising changed schemas
to connected clients each time. The removal:

- delete the repeating timer; keep the initial fetch, renamed to say what it now
  is (`fetchOpenApiDocOnce` / `primeRegistry`);
- delete the `HERMES_OPENAPI_REFRESH_INTERVAL_S` setting from `src/config.ts`,
  `.env`, `.env.example` and the README;
- keep `fetchOpenApiDoc`, which the startup fetch and the manual tool both use;
- keep `hermes_refresh_openapi` unchanged.

The startup fetch keeps its current failure behaviour: a failed fetch is logged
at `warn` and the registry keeps the bundled snapshot. The server starts either
way. That property is what makes removing the loop safe — the server has never
depended on the network to be useful.

### What this costs

A long-running server no longer notices a Hermes deployment mid-session. That
is the intent. The recovery path already exists and is now the only one:
`hermes_refresh_openapi`, whose description already tells an agent to call it
when a request is rejected for an argument the agent believes is correct.

## Part 2 — The gateway

### Identity: method + path, never operationId

Hermes generates `operationId`s from method names alone — the first three in the
document are `read`, `update` and `delete_1`. They are not unique in any useful
sense and cannot address an operation.

An operation is therefore identified by its **method and path template** exactly
as they appear in the document: `GET /api/v1/users/{id}`. Both tools speak this
vocabulary, and `hermes_call_api` requires both parts.

### `hermes_find_api`

Searches the loaded OpenAPI document and returns ranked candidates.

```
Arguments:
  query     string   required  Natural language: "get user info", "list campaigns"
  method    string   optional  Filter: get | post | put | patch | delete
  limit     number   optional  Default 10, max 25

Returns, per candidate:
  method, path, summary, tags
  pathParams[]   name, type, required, description
  queryParams[]  name, type, required, description
  requestBody    JSON Schema, resolved one $ref level deep, or null
  responseSchema JSON Schema for the 2xx response, or null
```

**Ranking** is lexical, not semantic — there is no embedding model here and
adding one for 356 operations would be disproportionate. Score each operation by
matching the query's tokens against, in descending weight: the path segments,
the `summary`, the `tags`, and the `description`. Exact segment matches outrank
substring matches. Ties break toward `GET`, then toward the shorter path, so
`GET /api/v1/users/{id}` outranks `POST /api/v1/stores/{storeId}/users/{userId}/block`
for the query "get user info".

**Payload size is the real constraint.** The document is 760 KB; ten fully
hydrated operations with resolved schemas could still be large. Two limits:
`$ref` resolution goes exactly one level deep and deeper refs are left as
`{"$ref": "#/components/schemas/Foo"}` strings, and the whole response is capped
at 60 KB with candidates dropped from the tail and a `truncated` count returned.
An agent that needs more narrows its query.

### `hermes_call_api`

Invokes one operation.

```
Arguments:
  method      string   required  get | post | put | patch | delete
  path        string   required  The path TEMPLATE: /api/v1/users/{id}
  pathParams  object   optional  { id: "usr_0rdj7kg2td04j" }
  query       object   optional  { page: 1, size: 20 }
  body        object   optional  JSON request body
```

Behaviour:

- The operation must exist in the loaded document. An unknown method+path is
  rejected as `UNKNOWN_OPERATION` naming the closest matches, and nothing is
  sent. This is what keeps the gateway bounded by Hermes' own surface rather
  than being an arbitrary HTTP client.
- Every `{placeholder}` in the template must be supplied in `pathParams`. A
  missing one is `INVALID_ARGUMENTS`, not a request to a literal `{id}`.
- Path parameters are URL-encoded on substitution.
- Arguments are **not** validated against the operation's schema beyond the
  above. Hermes validates its own input, and its error message is more accurate
  than one reconstructed here. A rejected call returns Hermes' own error.
- The call goes through the existing `HermesClient`, so it inherits credential
  resolution, token renewal, `X-Request-ID` propagation, timeouts and the typed
  error mapping unchanged. The gateway adds no transport of its own.
- The cross-store guard must be **extended**, not merely reused. Today
  `assertActingOnOwnStore` (`src/tools/index.ts:157`) reads a flat
  `args.storeId`, which a curated tool has because its arguments are the
  operation's parameters directly. The gateway nests them one level down, so a
  `storeId` in `pathParams` or `body` would sail past the existing check. Lift
  the guard to take the candidate ids rather than the argument bag, and have the
  gateway pass `pathParams.storeId` and `body.storeId` (plus `storeId` itself,
  for the curated callers) through the same comparison. Without this, the
  gateway is a cross-tenant hole — and it is one the existing tests would not
  catch, because they exercise the flat shape.

### Where the code goes

```
src/tools/gateway.ts        both tools, registered from tools/index.ts
src/registry/search.ts      ranking and candidate compilation over OpenApiDocument
src/registry/operations.ts  method+path index, $ref resolution, template substitution
```

Keeping search separate from the tool wrapper is what makes ranking testable
without an MCP server. `src/registry/schemaRegistry.ts` is left alone — it
compiles the twelve curated tools and has a different job.

### What the descriptions must say

Tool descriptions are the only thing a model sees when choosing. Both must state:

- that the twelve curated `hermes_*` tools are preferred where they apply, and
  name the domain they cover;
- that `hermes_find_api` is the way to answer "is there an API for X";
- that `hermes_call_api` can modify and delete data, that the client should
  confirm with a human before any non-`GET` call, and that the server will not
  ask.

## Testing

Unit, against a small fixture document rather than the real 760 KB one:

- ranking puts `GET /api/v1/users/{id}` first for "get user info"
- `method` filter excludes non-matching operations
- one-level `$ref` resolution; deeper refs left as strings
- the 60 KB cap drops from the tail and reports `truncated`
- unknown method+path is `UNKNOWN_OPERATION` and sends nothing
- a missing path parameter is `INVALID_ARGUMENTS` and sends nothing
- path parameters are URL-encoded
- a cross-store `storeId` is refused when it appears at the top level, inside
  `pathParams`, and inside `body` — three cases, since the nested two are new
- credentials resolve identically to a curated tool (`_meta`, HTTP, env fallback)

Integration, through the in-process transport as `test/integration.test.ts` does:

- both tools appear in `tools/list` with descriptions over the 120-char floor
- a call with no credentials is `MISSING_CREDENTIALS` before any fetch
- a non-`GET` invocation logs at `warn` naming method and path

Against the live spec, one test only: every operation in the bundled snapshot
compiles without throwing. This catches a Hermes document shape the resolver
does not handle, without asserting on content that changes.

## Out of scope

- Semantic or embedding-based search.
- Response filtering or pagination of Hermes results.
- Caching invocation results.
- Any confirmation or approval flow inside the server.
- Changes to the twelve curated tools.

## Open question for review

`.gitignore` ignores `docs`, so this file will not commit as written. Either
narrow the rule to the generated directory it was meant for, or the spec lives
somewhere else. Flagging rather than editing `.gitignore` unasked.
