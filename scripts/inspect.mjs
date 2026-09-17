/**
 * One entry point for every `npm run inspect*` script.
 *
 * It exists to solve the thing that makes inspecting this server awkward: the
 * server holds no credential of its own, so a bare Inspector session answers
 * every tool call with MISSING_CREDENTIALS. This reads your credentials once,
 * from a gitignored `.env`, and hands them to the Inspector the way each of its
 * clients can actually accept them:
 *
 * - **CLI** — as `--tool-metadata`, i.e. real per-call `_meta`. This is the
 *   same path a production client uses, so what you inspect is what ships.
 * - **web / TUI** — neither has a `--tool-metadata` equivalent, so the
 *   credentials go in as `-e` environment variables and the server picks them
 *   up through its single-user fallback. Same identity, different seam.
 *
 * Nothing is written anywhere: `.env` is the only store, and it is gitignored.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const LAUNCHER = "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js";
const CONFIG = "inspector.json";

const ACCESS_TOKEN_KEY = "com.superfans.hermes/accessToken";
const STORE_ID_KEY = "com.superfans.hermes/storeId";

/** Server settings worth forwarding from `.env`, beyond the credentials themselves. */
const FORWARDED_ENV = [
  "HERMES_BASE_URL",
  "HERMES_OPENAPI_DOCS_URL",
  "HERMES_OPENAPI_REFRESH_INTERVAL_S",
  "HERMES_MCP_LOG_LEVEL",
];

const argv = process.argv.slice(2);
const mode = ["--cli", "--tui", "--web"].find((m) => argv.includes(m)) ?? "--web";
const passthrough = argv.filter((a) => a !== mode);

// `--no-creds` inspects the server as an unauthenticated caller would see it —
// the way to check the MISSING_CREDENTIALS path itself is still intact.
const wantsCreds = !passthrough.includes("--no-creds");
const forwarded = passthrough.filter((a) => a !== "--no-creds");

if (existsSync(".env")) {
  // Values already in the real environment win, so a one-off
  // `HERMES_STORE_ID=… npm run inspect` overrides the file without editing it.
  process.loadEnvFile(".env");
}

const accessToken = process.env.HERMES_ACCESS_TOKEN ?? "";
const storeId = process.env.HERMES_STORE_ID ?? "";
const haveCreds = wantsCreds && accessToken !== "" && storeId !== "";

const args = [LAUNCHER, mode, "--config", CONFIG];

// `--server` selects a named entry under --cli only; the web client warns at it
// and the TUI rejects it as an unknown option.
if (mode === "--cli") args.push("--server", "hermes-mcp");

for (const key of FORWARDED_ENV) {
  const value = process.env[key];
  if (value) args.push("-e", `${key}=${value}`);
}

if (haveCreds && mode !== "--cli") {
  // The single-user fallback: one identity for the whole session, which is all
  // the web UI and TUI can express.
  args.push("-e", `HERMES_ACCESS_TOKEN=${accessToken}`, "-e", `HERMES_STORE_ID=${storeId}`);
}

const callsATool = forwarded.includes("tools/call");
const alreadyHasMetadata = forwarded.includes("--tool-metadata");

args.push(...forwarded);

if (haveCreds && mode === "--cli" && callsATool && !alreadyHasMetadata) {
  // Appended last: `--tool-metadata` is variadic, so anything after it would be
  // swallowed as another key=value pair.
  args.push("--tool-metadata", `${ACCESS_TOKEN_KEY}=${accessToken}`, `${STORE_ID_KEY}=${storeId}`);
}

// Never the token itself — only whether one was found, and for which store.
if (haveCreds) {
  const seam = mode === "--cli" ? "_meta (--tool-metadata)" : "env fallback (-e)";
  process.stderr.write(`hermes-mcp: sending credentials for store ${storeId} via ${seam}\n`);
} else if (wantsCreds) {
  process.stderr.write(
    "hermes-mcp: no credentials found — tool calls will answer MISSING_CREDENTIALS.\n" +
      "            Copy .env.example to .env and fill in HERMES_ACCESS_TOKEN and HERMES_STORE_ID.\n"
  );
}

spawn(process.execPath, args, { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));
