/**
 * A non-interactive smoke test of the built server, driven through the MCP
 * Inspector's CLI — the same client a human uses via `npm run inspect`, so this
 * exercises the real stdio protocol path rather than an in-process transport
 * the way `test/integration.test.ts` does.
 *
 * It needs no Hermes credentials and makes no outbound request: both tool calls
 * below are pointed at a dead host, so what is asserted is how far each call
 * *gets*, which is exactly the credential contract. Safe to run in CI.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LAUNCHER = "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js";

/**
 * Every tool call is aimed at a closed port, so nothing here can reach Hermes
 * — or anything else. A call that resolves its credentials therefore fails with
 * UNAVAILABLE, which is precisely how we tell "got past the credential check"
 * apart from "was rejected by it".
 */
const DEAD_HOST = [
  "-e",
  "HERMES_BASE_URL=http://127.0.0.1:9/",
  "-e",
  "HERMES_OPENAPI_DOCS_URL=http://127.0.0.1:9/v3/api-docs",
  "-e",
  "HERMES_MCP_LOG_LEVEL=silent",
];

/** The description floor from `test/integration.test.ts`, restated at the protocol edge. */
const MIN_DESCRIPTION_CHARS = 120;

const failures = [];
const check = (ok, label, detail = "") => {
  if (ok) {
    process.stdout.write(`  ok   ${label}\n`);
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
};

/**
 * Runs one Inspector CLI invocation and returns its JSON result.
 *
 * The exit code is deliberately ignored: the CLI exits non-zero when a tool
 * returns `isError: true`, and two of the three calls below expect exactly
 * that. The payload is the assertion surface, not the status.
 */
const runInspector = (args) => {
  // The server process inherits this environment through the Inspector, so a
  // developer with HERMES_ACCESS_TOKEN exported in their shell would silently
  // satisfy the single-user fallback and break the "no _meta is refused" check.
  // Scrubbing both makes the run identical on a laptop and in CI.
  const env = { ...process.env };
  delete env.HERMES_ACCESS_TOKEN;
  delete env.HERMES_STORE_ID;

  const result = spawnSync(
    process.execPath,
    [LAUNCHER, "--cli", "--config", "inspector.json", "--server", "hermes-mcp", ...args],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, env }
  );
  if (result.error) throw result.error;
  return result;
};

const callInspector = (args) => {
  const result = runInspector(args);

  const line = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && ("result" in parsed || "error" in parsed));

  if (!line) {
    throw new Error(
      `No JSON result from the Inspector.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return line;
};

const textOf = (payload) => payload?.result?.content?.[0]?.text ?? "";

/** The allowlist, read from source so this check cannot drift from it. */
const expectedToolNames = () => {
  const endpoints = readFileSync("src/registry/endpoints.ts", "utf-8");
  const names = [...endpoints.matchAll(/toolName:\s*"([^"]+)"/g)].map((m) => m[1]);
  const tools = readFileSync("src/tools/index.ts", "utf-8");
  const refresh = /REFRESH_TOOL\s*=\s*"([^"]+)"/.exec(tools)?.[1];
  if (names.length === 0 || !refresh) {
    throw new Error("Could not read the tool allowlist out of src/ — has the layout changed?");
  }
  return [...names, refresh];
};

process.stdout.write("Inspecting the built server over stdio via the MCP Inspector CLI\n\n");

process.stdout.write("tools/list\n");
const expected = expectedToolNames();
const listed = callInspector([...DEAD_HOST, "--method", "tools/list", "--format", "json"]);
const tools = listed.result?.tools ?? [];
const advertised = tools.map((t) => t.name).sort();

check(
  JSON.stringify(advertised) === JSON.stringify([...expected].sort()),
  `advertises exactly the ${expected.length} allowlisted tools`,
  advertised.length === 0 ? "nothing advertised" : `got ${advertised.join(", ")}`
);

const thin = tools.filter((t) => (t.description?.length ?? 0) < MIN_DESCRIPTION_CHARS);
check(
  thin.length === 0,
  `every tool carries a description of at least ${MIN_DESCRIPTION_CHARS} characters`,
  thin.map((t) => `${t.name} (${t.description?.length ?? 0})`).join(", ")
);

const missingSchema = tools.filter((t) => typeof t.inputSchema !== "object");
check(missingSchema.length === 0, "every tool carries an input schema", missingSchema.map((t) => t.name).join(", "));

// The Inspector's own portability audit, held at zero. A schema that "carries
// no validation keyword at all" is the failure mode this catches: it advertises
// a shape to the model while constraining nothing.
// A clean audit prints nothing at all and exits 0, so that is what is asserted
// — there is no "0 errors, 0 warnings" line to match on. Exit 6 means an
// error-severity finding; warnings are reported without changing the status,
// hence the separate scan for them.
const strict = runInspector([...DEAD_HOST, "--method", "tools/list", "--strict"]);
const reported = `${strict.stdout}\n${strict.stderr}`;
const problems = [...reported.matchAll(/^\s*(Warning|Error): (.+)$/gm)].map((m) => `${m[1]}: ${m[2]}`);
check(
  strict.status === 0 && problems.length === 0,
  "passes the Inspector's schema-portability audit with no errors or warnings",
  problems.length > 0 ? problems.join("; ") : `exit ${strict.status}`
);

process.stdout.write("\ntools/call — the credential contract\n");

const withoutMeta = callInspector([
  ...DEAD_HOST,
  "--method",
  "tools/call",
  "--tool-name",
  "hermes_get_widget",
  "--tool-arg",
  "id=w1",
  "--format",
  "json",
]);
check(
  textOf(withoutMeta).includes("MISSING_CREDENTIALS"),
  "a call with no _meta is refused before any request is made",
  textOf(withoutMeta).slice(0, 160)
);

const withMeta = callInspector([
  ...DEAD_HOST,
  "--method",
  "tools/call",
  "--tool-name",
  "hermes_get_widget",
  "--tool-arg",
  "id=w1",
  "--tool-metadata",
  "com.superfans.hermes/accessToken=smoke-token",
  // Deliberately numeric: the Inspector JSON-parses `key=value`, and a store id
  // arriving as a number must still resolve to a usable identity.
  "com.superfans.hermes/storeId=1234",
  "--format",
  "json",
]);
check(
  !textOf(withMeta).includes("MISSING_CREDENTIALS") && textOf(withMeta).includes("UNAVAILABLE"),
  "a call carrying credentials in _meta resolves them and reaches the transport",
  textOf(withMeta).slice(0, 160)
);

process.stdout.write("\n");
if (failures.length > 0) {
  process.stderr.write(`${failures.length} check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("All checks passed.\n");
