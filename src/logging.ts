import type { LogLevel } from "./config.js";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const REDACTED_KEYS = new Set(["authorization", "accesstoken", "token", "password", "refreshtoken"]);

const redact = (meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return out;
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
