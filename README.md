# hermes-mcp

A stdio MCP server exposing a curated set of Hermes Atlas REST endpoints as
tools. It holds **no identity of its own**: every tool call carries the end
user's own Hermes credentials, supplied by the client on that call.

Design docs:
[base design](docs/superpowers/specs/2026-09-08-hermes-mcp-design.md) ·
[auth, tracing & refresh](docs/superpowers/specs/2026-09-08-hermes-mcp-auth-design.md)

## Quick start

```bash
npm install
npm run build     # esbuild -> dist/server.js
npm start         # node dist/server.js -- speaks MCP over stdio
```

## Authentication

There is no login, no browser flow and no credential file. The client sends the
user's credentials in the `_meta` of each `tools/call`, and this server turns
them straight into Hermes request headers:

| `_meta` key | Hermes header | Required |
|---|---|---|
| `com.superfans.hermes/accessToken` | `Authorization: Bearer <token>` | Yes |
| `com.superfans.hermes/storeId` | `X-Store-Id` | Yes |
| `com.superfans.hermes/requestId` | `X-Request-ID` | No — for tracing |

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "hermes_get_active_theme",
    "arguments": {},
    "_meta": {
      "com.superfans.hermes/accessToken": "eyJhbGciOi…",
      "com.superfans.hermes/storeId": "1234",
      "com.superfans.hermes/requestId": "b7f2c1a0"
    }
  }
}
```

The bare key names `accessToken`, `storeId` and `requestId` are accepted too,
for calls typed by hand. The namespaced form is the contract a client should
send: MCP reserves only `io.modelcontextprotocol/*` inside `_meta`, so a
reverse-DNS namespace cannot collide with a future spec key.

This mirrors how the AI Server talks to Hermes
(`ai-server/src/ai_server/context/hermes_client.py`), and for the same reasons:

- there is one source of truth for auth, and it cannot drift;
- the user's existing authorisation applies unchanged — a tool can only ever
  read or write what that user could already read or write;
- no second identity system exists to keep in sync.

The credential belongs to a request, never to the process: it is read per call
and never cached, so one caller's token can never serve another's call. It
follows that this server cannot refresh a token — it holds no refresh token and
no session. A `401` from Hermes means *the caller's* session was rejected, and
is surfaced to them as `[UNAUTHENTICATED]` for them to act on.

The token and store id are resolved as a unit. A call that supplies one but not
the other is refused outright rather than completed from the environment, so a
caller can never act with their own token against somebody else's store.

### Single-user fallback

For a local run or a CI script, `HERMES_ACCESS_TOKEN` and `HERMES_STORE_ID` act
as a fallback identity, used **only** when a call carries no credentials of its
own. Credentials on the call always win.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HERMES_MCP_LOG_LEVEL` | `info` | `silent`\|`error`\|`warn`\|`info`\|`debug` |
| `HERMES_BASE_URL` | `https://hermes-atlas.vjr-dev.com` | Host root tool calls go to |
| `HERMES_OPENAPI_DOCS_URL` | `https://hermes-atlas.vjr-dev.com/v3/api-docs` | Where tool schemas refresh from. Separate setting from `HERMES_BASE_URL`, but point both at the same environment. |
| `HERMES_OPENAPI_REFRESH_INTERVAL_S` | `900` | Background schema refresh interval |
| `HERMES_ACCESS_TOKEN` | — | Single-user fallback only; see above. Set with `HERMES_STORE_ID` or neither. |
| `HERMES_STORE_ID` | — | See above |

## Register with Claude Code

`dist/` is a build artifact and is not committed — run `npm run build` once
before registering, and again after any change under `src/`.

```bash
claude mcp add hermes-mcp --scope user -e HERMES_MCP_LOG_LEVEL=info \
  -e HERMES_ACCESS_TOKEN=… -e HERMES_STORE_ID=… \
  -- node "/absolute/path/to/hermes-mcp/dist/server.js"
```

Claude Code does not attach Hermes credentials to `_meta`, so an interactive
registration uses the single-user fallback above. A programmatic client — the
AI Server or agent — should omit those env vars and send each end user's own
credentials per call instead.

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

Each tool's **description** — what it returns, what it is for, and how it
relates to the others — is written in `src/registry/endpoints.ts`, because that
text is all a calling model sees before choosing between them. Each tool's
**input schema** is compiled from Hermes's own OpenAPI document and refreshed
from the live spec at startup, every 15 minutes, and whenever
`hermes_refresh_openapi` is called, so parameter-level help is never duplicated
by hand.

Adding a twelfth Hermes operation is one entry in `src/registry/endpoints.ts`;
`test/registry/schemaRegistry.test.ts` fails loudly if it doesn't compile
against the checked-in snapshot.

## Inspecting the server

[MCP Inspector](https://github.com/modelcontextprotocol/inspector) is wired up
as a dev dependency, driven by the committed [`inspector.json`](inspector.json)
so the server command lives in one place. Each script rebuilds `dist/` first.

```bash
npm run inspect         # web UI
npm run inspect:tui     # terminal UI
npm run inspect:cli     # scriptable CLI — see below
npm run inspect:smoke   # non-interactive check, no credentials needed
```

The Inspector requires Node `>=22.19`, above this package's own `>=20` floor.
That applies only to the `inspect:*` scripts — the server itself still runs on
Node 20.

### Sending credentials while inspecting

The server holds no credential of its own, so a bare Inspector session answers
every tool call with `MISSING_CREDENTIALS`. Store yours once in a gitignored
`.env` and every `inspect` script picks them up:

```bash
cp .env.example .env     # then fill in HERMES_ACCESS_TOKEN and HERMES_STORE_ID
npm run inspect
```

To get those two values: log into the Dashboard for the store you want, and copy
`STORE_ACCESS_TOKEN` and `STORE_ID` out of `localStorage`. The token expires, so
re-copy it when calls start coming back `UNAUTHENTICATED` — nothing here can
refresh it. `.env` is already in `.gitignore`; never commit a real token.

[`scripts/inspect.mjs`](scripts/inspect.mjs) then hands them to whichever client
you asked for, by the only route that client supports:

| Client | How the credentials travel |
|---|---|
| `inspect:cli` | `--tool-metadata`, i.e. real per-call `_meta` — the same path a production client uses |
| `inspect`, `inspect:tui` | `-e` env vars, picked up by the single-user fallback; neither UI can set `_meta` |

It prints which route it used and for which store, never the token. Anything you
pass is forwarded on, so the raw flags still work:

```bash
# let the script attach your .env credentials as _meta
npm run inspect:cli -- --method tools/call --tool-name hermes_get_active_theme --format json

# or spell the metadata out yourself — an explicit --tool-metadata is left alone
npm run inspect:cli -- --method tools/call --tool-name hermes_get_active_theme \
  --tool-metadata com.superfans.hermes/accessToken=eyJhbGciOi… \
                  com.superfans.hermes/storeId=1234 --format json

# inspect as an unauthenticated caller, to check the refusal path itself
npm run inspect:cli -- --no-creds --method tools/call --tool-name hermes_get_active_theme
```

`--tool-metadata` JSON-parses each `key=value` pair, so `storeId=1234` arrives
as a **number**. That is accepted — a numeric store id is coerced to a string
rather than refused.

A one-off override needs no edit to `.env`, because a real environment variable
wins over the file:

```bash
HERMES_STORE_ID=9999 npm run inspect:cli -- --method tools/list
```

### `npm run inspect:smoke`

Connects over real stdio through the Inspector CLI and asserts that the server
advertises exactly the allowlisted tools, that every one carries a substantial
description and an input schema, that the tool schemas pass the Inspector's
`--strict` portability audit with no errors *or* warnings, and that the
credential contract holds at both ends — a call with no `_meta` is refused
before any request is made, and a call carrying `_meta` resolves it and reaches
the transport.

It scrubs `HERMES_ACCESS_TOKEN` / `HERMES_STORE_ID` from the environment it
hands the server, so it behaves identically whether or not you have a `.env`.

It needs no Hermes credentials and makes no outbound request (both tool calls
are aimed at a closed port, so what is asserted is how far each call *gets*),
which makes it safe for CI. It exits non-zero on the first failed check.

## Debugging

Set `HERMES_MCP_LOG_LEVEL=debug` to get, per tool call, a `tool call start` line
with the resolved method/path/query and the acting store id, and a matching
`tool call ok` (or `tool call failed`) line — both tagged with the same short
`traceId`, so one call's full path through the server can be grepped out of the
stderr stream. Pass `com.superfans.hermes/requestId` to correlate those lines
with the caller's own trace and with Hermes's. Tokens are never logged at any
level.

## Tests

```bash
npm test
npm run test:watch
```

## Hard constraints

1. Never write to stdout under `src/` — stdout is the MCP transport.
2. Never persist a credential. Credentials arrive per call and live only for
   the duration of that call.
3. Never expose a Hermes operation that isn't a named entry in
   `src/registry/endpoints.ts`.
4. Never log a token, at any log level.
