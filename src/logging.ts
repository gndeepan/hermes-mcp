import type { LogLevel } from "./config.js";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const REDACTED_KEYS = new Set(["authorization", "accesstoken", "token", "password", "refreshtoken"]);

/** Deep enough for any meta this codebase logs, shallow enough to stay cheap. */
const MAX_REDACT_DEPTH = 8;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Recurses into plain objects and arrays so a redacted key name is caught at
 * any depth, not just the top level. This matters because `wrap()` logs the
 * whole `query` object, whose key set is rebuilt from the *live* OpenAPI
 * document — a future Hermes query param called `token` or `accessToken` would
 * otherwise be logged verbatim at `debug`, breaking the "never log a token"
 * constraint with no change to this repo at all.
 *
 * `path` tracks only the current recursion path, so a genuinely cyclic object
 * is cut off while a value referenced twice in different branches still
 * renders. Anything that is not a plain object or array (a `Date`, an `Error`)
 * is passed through untouched — no call site logs one, and rewriting them would
 * lose their serialization.
 */
const redactValue = (value: unknown, path: Set<object>, depth: number): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACT_DEPTH) return "[TRUNCATED]";
  if (path.has(value)) return "[CIRCULAR]";
  if (!Array.isArray(value) && !isPlainObject(value)) return value;

  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, path, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactValue(nested, path, depth + 1);
    }
    return out;
  } finally {
    path.delete(value);
  }
};

const redact = (meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!meta) return meta;
  return redactValue(meta, new Set<object>(), 0) as Record<string, unknown>;
};

export const createLogger = (
  config: { logLevel: LogLevel },
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  }
): Logger => {
  const threshold = LEVEL_ORDER[config.logLevel];
  const log = (
    level: Exclude<LogLevel, "silent">,
    message: string,
    meta?: Record<string, unknown>
  ): void => {
    if (LEVEL_ORDER[level] > threshold) return;
    write(JSON.stringify({ level, message, ts: new Date().toISOString(), ...redact(meta) }) + "\n");
  };
  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  };
};
