# hermes-mcp

A stdio MCP server exposing a curated set of Hermes Atlas REST endpoints as
tools. It holds **no identity of its own**: every tool call carries the end
user's own Hermes credentials, supplied by the client on that call.

Design docs:
[base design](https://bitbucket.org/vajro/hermes-mcp/src/main/docs/superpowers/specs/2026-09-08-hermes-mcp-design.md) ·
[auth, tracing & refresh](https://bitbucket.org/vajro/hermes-mcp/src/main/docs/superpowers/specs/2026-09-08-hermes-mcp-auth-design.md)

(Absolute links: the published tarball ships only `dist/`, the OpenAPI
snapshot and this README, so relative paths into `docs/` resolve on Bitbucket
but not from an install.)

## Install

Published as **`@superfans/hermes-mcp`** to the Vajro workspace's
[Bitbucket Packages](https://npm.apkg.io/vajro/) registry.

Authenticate once, in `~/.npmrc`:

```ini
# ~/.npmrc
@superfans:registry=https://npm.apkg.io/vajro/
//npm.apkg.io/vajro/:username=<your-atlassian-email>
//npm.apkg.io/vajro/:_password=<api-token, base64-encoded>
```

Two details in there are worth getting right, because each fails in a way that
points somewhere else:

- **Map the `@superfans` scope, never a bare `registry=`.** A bare one sends
  *every* package to Bitbucket Packages, which hosts only Vajro's own and does
  not proxy npmjs — so this server's dependencies 404 and the install dies
  before it runs: `404 Not Found - GET https://npm.apkg.io/vajro/@modelcontextprotocol%2fserver`.
  Scoped, only `@superfans/*` goes to Bitbucket and everything else resolves
  from npmjs as usual.
- **Base64-encode the API token.** npm expects `_password` encoded, and a raw
  token there fails `E401` on every request, `publish` included — including
  `npm whoami`, confusingly, *succeeding* anyway.

  ```bash
  echo -n '<atlassian-api-token>' | base64 -w 0
  ```

### Run it with `npx`

No install step, no clone, no build:

```bash
npx -y @superfans/hermes-mcp
```

The package ships two executables:

| Command | Entry | Transport |
|---|---|---|
| `hermes-mcp` | `dist/server.js` | stdio — one client, the usual MCP case |
| `hermes-mcp-http` | `dist/httpServer.js` | HTTP on `PORT` (default `8787`) — the shared multi-merchant service |

`npx` runs the stdio one by default; `-p` picks the other:

```bash
npx -y @superfans/hermes-mcp                                  # stdio
PORT=9000 npx -y -p @superfans/hermes-mcp hermes-mcp-http     # HTTP
```

Run with no credentials, the server starts and speaks MCP but answers every
tool call with `MISSING_CREDENTIALS`. That is the designed behaviour, not a
misconfiguration — see [Authentication](#authentication).

Add it to a project, or install it globally to avoid refetching each run:

```bash
npm install @superfans/hermes-mcp
npm install -g @superfans/hermes-mcp && hermes-mcp
```

## From source

For developing the server itself:

```bash
npm install
npm run build     # esbuild -> dist/server.js, dist/httpServer.js
npm start         # node dist/server.js -- speaks MCP over stdio
npm run start:http
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
| `com.superfans.hermes/refreshToken` | none — see [Session renewal](#session-renewal) | No |
| `com.superfans.hermes/expiresAt` | none | No |

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

The bare key names `accessToken`, `storeId`, `requestId`, `refreshToken` and
`expiresAt` are accepted too,
for calls typed by hand. The namespaced form is the contract a client should
send: MCP reserves only `io.modelcontextprotocol/*` inside `_meta`, so a
reverse-DNS namespace cannot collide with a future spec key.

This mirrors how the AI Server talks to Hermes
(`ai-server/src/ai_server/context/hermes_client.py`), and for the same reasons:

- there is one source of truth for auth, and it cannot drift;
- the user's existing authorisation applies unchanged — a tool can only ever
  read or write what that user could already read or write;
- no second identity system exists to keep in sync.

The credential belongs to a request, never to the process: it is read per call,
so one caller's token can never serve another's call. This server still holds
no identity of its own — it carries the end user's.

The token and store id are resolved as a unit. A call that supplies one but not
the other is refused outright rather than completed from the environment, so a
caller can never act with their own token against somebody else's store. The
renewal keys are resolved from that same source, never mixed with another.

### Session renewal

Access tokens expire. A caller that sends `refreshToken` is granting this
server permission to renew **that** session, and nothing else. Renewal fires on
two triggers:

- **Before the call**, when `expiresAt` (epoch milliseconds; seconds are
  normalised) is within 60 seconds of now or already past — so a known-dead
  token never costs a failed round trip.
- **After a `401`**, because `expiresAt` is a claim and Hermes's answer is a
  fact: clocks drift, sessions get revoked, and a caller need not send an
  expiry at all. The request is retried exactly **once**. Retrying is safe even
  for a write: a `401` means Hermes refused the request before acting on it.

Renewal calls `POST /api/v1/auth/refresh` with the refresh token as the whole
body, and replaces only the credential. It never changes the store the call
acts on — the `userId` and `stores` in the refresh response are ignored, so an
auth response can never widen a call's scope.

Renewed tokens are held in memory, keyed by the **SHA-256 of the refresh
token**. The key is the secret: an entry is reachable only by a caller who
already holds the session that produced it, so nothing here widens what anyone
can reach. Raw tokens are never used as keys and never logged.

**Send no `refreshToken` and behaviour is exactly as before**: a `401` from
Hermes is surfaced as `[UNAUTHENTICATED]` for the caller to act on. When the
refresh token is itself refused, the call fails as `[SESSION_EXPIRED]` — a
distinct code, because it has exactly one remedy: the merchant signs in again.

Over HTTP the same two values are read from the `X-Refresh-Token` and
`X-Token-Expires-At` headers.

### Single-user fallback

For a local run or a CI script, `HERMES_ACCESS_TOKEN` and `HERMES_STORE_ID` act
as a fallback identity, used **only** when a call carries no credentials of its
own. Credentials on the call always win.

The fallback is **off unless you set `HERMES_SINGLE_USER=1`**, and that default
is the safety property, not an inconvenience. This process is shared — the
ai-agent runs one child and puts each caller's identity on the call — and in a
shared process a silent env fallback means a call that lost its credentials
acts as whatever merchant happens to be in the environment. That is a
cross-tenant read that looks exactly like success. Opting in says *this process
serves one merchant and that is the point*.

So set all three together for a local run, or none of them for a server:

```bash
HERMES_ACCESS_TOKEN=… HERMES_STORE_ID=… HERMES_SINGLE_USER=1 \
  npx -y @superfans/hermes-mcp
```

Set the token and store id but not `HERMES_SINGLE_USER` and the server starts
normally and refuses every uncredentialed call with `MISSING_CREDENTIALS`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HERMES_MCP_LOG_LEVEL` | `info` | `silent`\|`error`\|`warn`\|`info`\|`debug` |
| `HERMES_BASE_URL` | `https://hermes-atlas.vjr-dev.com` | Host root tool calls go to |
| `HERMES_OPENAPI_DOCS_URL` | `https://hermes-atlas.vjr-dev.com/v3/api-docs` | Where tool schemas refresh from. Separate setting from `HERMES_BASE_URL`, but point both at the same environment. |
| `HERMES_OPENAPI_REFRESH_INTERVAL_S` | `900` | Background schema refresh interval |
| `HERMES_ACCESS_TOKEN` | — | Single-user fallback only; see above. Set with `HERMES_STORE_ID` or neither. |
| `HERMES_STORE_ID` | — | See above |
| `HERMES_REFRESH_TOKEN` | — | Optional. Lets a long local run or CI job survive an expiry. Needs the two above alongside it. |
| `HERMES_SINGLE_USER` | unset | `1` turns the three above on. Without it they are ignored — see [Single-user fallback](#single-user-fallback). |
| `PORT` | `8787` | `hermes-mcp-http` only. Ignored by the stdio entry. |

## Register with Claude Code

From the published package — nothing to clone or build:

```bash
claude mcp add hermes-mcp --scope user -e HERMES_MCP_LOG_LEVEL=info \
  -e HERMES_ACCESS_TOKEN=… -e HERMES_STORE_ID=… -e HERMES_SINGLE_USER=1 \
  -- npx -y @superfans/hermes-mcp
```

Or from a working copy, when you are changing the server. `dist/` is a build
artifact and is not committed — run `npm run build` once before registering,
and again after any change under `src/`:

```bash
claude mcp add hermes-mcp --scope user -e HERMES_MCP_LOG_LEVEL=info \
  -e HERMES_ACCESS_TOKEN=… -e HERMES_STORE_ID=… -e HERMES_SINGLE_USER=1 \
  -- node "/absolute/path/to/hermes-mcp/dist/server.js"
```

Either form needs `HERMES_SINGLE_USER=1` alongside the token and store id.
Without it the fallback identity is ignored and every call is refused — see
[Single-user fallback](#single-user-fallback).

The equivalent JSON, for a client configured by file rather than by CLI. A
ready-made copy is committed as [`.mcp.json`](.mcp.json), which Claude Code picks
up automatically when this repository is the project root. It carries no
credentials: the values are `${VAR:-default}` references resolved from your
environment at launch, so export `HERMES_ACCESS_TOKEN` and `HERMES_STORE_ID`
before starting the client.


```jsonc
{
  "mcpServers": {
    "hermes-mcp": {
      "command": "npx",
      "args": ["-y", "@superfans/hermes-mcp"],
      "env": {
        "HERMES_ACCESS_TOKEN": "…",
        "HERMES_STORE_ID": "…",
        "HERMES_SINGLE_USER": "1"
      }
    }
  }
}
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

A refresh picks up a **modified** operation automatically, deliberately ignores
an **added** one, and reports a **removed** one as `stale` while keeping the
tool working on its last schema.
[docs/openapi-refresh.md](https://bitbucket.org/vajro/hermes-mcp/src/main/docs/openapi-refresh.md)
sets out each case and why they differ.

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
`STORE_ACCESS_TOKEN` and `STORE_ID` out of `localStorage`. The token expires;
copy `STORE_REFRESH_TOKEN` into `HERMES_REFRESH_TOKEN` as well and the server
renews it for you. Without one, re-copy the access token when calls start coming
back `UNAUTHENTICATED`. `.env` is already in `.gitignore`; never commit a real
token.

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

## Publishing

```bash
npm run build && npm test && npm run typecheck
npm version <patch|minor|major>
npm publish            # registry comes from publishConfig
npm publish --dry-run  # inspect the tarball first
```

`publishConfig.registry` pins which registry the tarball is `PUT` to, so that
much does not depend on local config — though the `@superfans` scope mapping in
`.npmrc` still has to be right, as below. `files` restricts the tarball
to `dist/`, the OpenAPI snapshot and this README — five files. `.env` and
`.npmrc` are both gitignored and excluded; check a dry run before every release
anyway:

```bash
npm publish --dry-run 2>&1 | grep -E '\.npmrc|\.env'   # must print nothing
```

Two things that fail quietly and are worth knowing:

- **Write `bin` paths without a `./` prefix.** npm 11 silently drops
  `"./dist/server.js"` — `npm publish` warns `"bin[hermes-mcp]" script name
  dist/server.js was invalid and removed` and publishes with *no* executable,
  so every `npx` of the package fails. `"dist/server.js"` is kept. `npm pack`
  does not warn about this; only `npm publish` does.
- **`dist/` is gitignored but still published**, because `files` names it
  explicitly and that takes precedence. It is a build artifact, so build before
  publishing — nothing in the repo will remind you.
- **`openapi/hermes-api-docs.json` is a runtime dependency, not a dev asset.**
  `src/registry/snapshot.ts` reads it at startup to compile the tool schemas,
  so it must stay in `files`. Drop it and the published server still launches
  but dies on `ENOENT` before serving a tool — over stdio that surfaces only as
  a generic `Internal server error`, which is easy to misread as a
  configuration problem.

### If `publish` returns 404

```
npm error 404 Not Found - PUT https://npm.apkg.io/vajro/@superfans%2fhermes-mcp
```

The message reads as though the name is wrong; in practice it has meant the
`.npmrc` is. Check these two before renaming anything — both were observed to
produce a `404` on the `PUT` while `publish` was aimed at the correct URL by
`publishConfig`:

- **The `@superfans` scope is not mapped to this registry.** Adding
  `@superfans:registry=https://npm.apkg.io/vajro/` was what made the scoped
  publish go through; with only a bare `registry=` line the same credentials
  got a `404`, even though the unscoped `hermes-mcp` published fine.
- **The token is not base64-encoded.** A raw one under `_password` fails every
  read and write. `npm whoami` is no test of this — it answers correctly
  regardless.

### Verifying a release

From a directory that is not this one, so the local `.npmrc` and `node_modules`
cannot mask a packaging fault:

```bash
npx -y @superfans/hermes-mcp <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
```

A healthy release prints a `server ready` log with `"tools":12`, then a
successful `initialize` result. Anything else is a failure worth reading
closely: no output at all means the `bin` did not resolve, and an
`Internal server error` in place of the result usually means a file the server
reads at startup was left out of `files`.

## Hard constraints

1. Never write to stdout under `src/` — stdout is the MCP transport.
2. Never persist a credential. Credentials arrive per call and live only for
   the duration of that call.
3. Never expose a Hermes operation that isn't a named entry in
   `src/registry/endpoints.ts`.
4. Never log a token, at any log level.
