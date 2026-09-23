import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reading a local env file into the stdio entry's own environment.
 *
 * Why this exists at all. Over stdio the credential path that ships is
 * per-call `_meta`: the ai-agent serves many merchants through one child
 * process and puts the caller's identity on every call. Nothing here changes
 * that. But the clients a developer actually points at this server on their own
 * machine — Claude Code, Cursor, the Inspector's web UI — have no way to attach
 * `_meta` to a tool call. Their only seam is the process environment, and a
 * client config file can forward only variables that are *already* exported.
 * A `.env` is not exported, which is why credentials sitting correctly in one
 * still arrived as MISSING_CREDENTIALS: the file was never read by anybody.
 *
 * So the server reads it. The load is deliberately narrow:
 *
 * - **Only in single-user mode.** A shared process ignores the environment
 *   credential anyway, but it would still honour a stray `HERMES_BASE_URL`, and
 *   a file picked up from whatever directory the parent happened to spawn in
 *   must never be able to redirect a multi-tenant process at another host.
 *   Tying the load to `HERMES_SINGLE_USER=1` scopes it to the one case where
 *   "act as the configured merchant" is the entire intent.
 * - **A missing file is not an error.** The path has a default, so most callers
 *   never chose it, and crashing a server on the absence of a file nobody asked
 *   for would turn a convenience into a liability.
 * - **The real environment wins.** Node's loader does not overwrite a variable
 *   that is already set, which keeps a one-off `HERMES_STORE_ID=… npx …` ahead
 *   of the file without anyone editing it.
 */

/** Where the file is looked for when `HERMES_ENV_FILE` does not say. */
export const DEFAULT_ENV_FILE = ".env";

/**
 * Node's own dotenv reader, injected so a test can drive this without writing
 * to the real `process.env` — which is global, and which every other test in
 * the suite would then be reading.
 */
export type EnvFileLoader = (path: string) => void;

export interface EnvFileOptions {
  env?: NodeJS.ProcessEnv;
  loader?: EnvFileLoader;
  /** Resolution base for a relative path. The process working directory in practice. */
  cwd?: string;
}

/**
 * Loads the env file for a single-user run, and reports which file that was.
 *
 * Returns the absolute path actually read, or `null` when nothing was read —
 * not single-user, or no such file. The caller logs it, because "which file did
 * my credentials come from" is the first question asked when they turn out to
 * be the wrong ones.
 */
export const applyEnvFile = (options: EnvFileOptions = {}): string | null => {
  const env = options.env ?? process.env;
  const loader = options.loader ?? ((path: string) => process.loadEnvFile(path));

  // The gate, not an optimisation. See the module comment.
  if (env.HERMES_SINGLE_USER !== "1") return null;

  const requested = (env.HERMES_ENV_FILE ?? "").trim();
  // An explicit empty value is a way to say "read nothing", which a shared
  // harness that sets HERMES_SINGLE_USER for its own reasons may well want.
  if (env.HERMES_ENV_FILE !== undefined && requested === "") return null;

  const path = resolve(options.cwd ?? process.cwd(), requested === "" ? DEFAULT_ENV_FILE : requested);
  if (!existsSync(path)) return null;

  loader(path);
  return path;
};

/** The keys that make up the single-user identity in an env file. */
const CREDENTIAL_KEYS = ["HERMES_ACCESS_TOKEN", "HERMES_STORE_ID", "HERMES_REFRESH_TOKEN"] as const;

/**
 * Blanks the credential values in an env file, for `hermes_logout`.
 *
 * Without this a logout only lasts until the next restart, when the file hands
 * the same identity straight back. Values are emptied rather than lines
 * deleted, so the file keeps its shape and its comments and the developer can
 * see exactly where to paste a token again. Everything else in the file —
 * host, log level — is left alone.
 *
 * Returns the keys that actually held a value, so the caller can report what
 * was cleared. A missing or unwritable file clears nothing and says so by
 * returning an empty list: a logout that removed the stored session has still
 * done most of its job.
 */
export const clearEnvCredentials = (path: string): string[] => {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const cleared: string[] = [];
  let next = text;
  for (const key of CREDENTIAL_KEYS) {
    // Up to the line ending and no further, so a CRLF file stays CRLF.
    const line = new RegExp(`^([ \t]*(?:export[ \t]+)?${key}[ \t]*=)([^\r\n]*)`, "gm");
    next = next.replace(line, (_match, head: string, value: string) => {
      if (value.trim() !== "" && !cleared.includes(key)) cleared.push(key);
      return head;
    });
  }

  if (next === text) return [];
  try {
    writeFileSync(path, next, "utf-8");
  } catch {
    return [];
  }
  return cleared;
};
