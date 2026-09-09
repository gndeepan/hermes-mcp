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
| `HERMES_BASE_URL` | `https://hermes-atlas.vjr-dev.com` | Host root tool calls and login go to |
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
