import type { EnvCredentials } from "./userContext.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

export interface HermesMcpConfig {
  logLevel: LogLevel;
  serverName: string;
  serverVersion: string;
  hermesBaseUrl: string;
  openApiDocsUrl: string;
  openApiFetchTimeoutMs: number;
  /**
   * A single-user fallback identity for local runs and CI, used only when a
   * tool call carries no credentials in its `_meta`. A real client sends its
   * own per-request credentials, which always win over this.
   */
  credentials: EnvCredentials | null;
  /**
   * Whether this process serves exactly one merchant.
   *
   * Off by default, and that default is the safety property. The stdio entry
   * used to be one process per merchant, so falling back to `credentials` when
   * a call carried no `_meta` was harmless. It is now shared — the ai-agent
   * runs one child and puts the caller's identity on each call — and in a
   * shared process that fallback means a call that lost its credentials
   * silently acts as whatever merchant is in the environment. Which is a
   * cross-tenant read that looks exactly like success.
   *
   * Set `HERMES_SINGLE_USER=1` for a local run or CI, where acting as the one
   * configured merchant is the whole point.
   */
  singleUser: boolean;
  /**
   * How long a tool call that triggered a browser sign-in waits for it to
   * finish before answering SIGN_IN_REQUIRED.
   *
   * Below 60 seconds by default because that is the request timeout many MCP
   * clients apply, and a call the client has already abandoned delivers
   * nothing. A client that allows longer can raise it with
   * `HERMES_LOGIN_WAIT_MS`. Either way the sign-in itself stays open for its
   * full five minutes, and the next call joins it.
   */
  loginWaitMs: number;
}

const DEFAULT_LOGIN_WAIT_MS = 50_000;

const parseLoginWait = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOGIN_WAIT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid HERMES_LOGIN_WAIT_MS "${raw}". Use a non-negative number of milliseconds.`);
  }
  return Math.round(n);
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): HermesMcpConfig => {
  const rawLogLevel = env.HERMES_MCP_LOG_LEVEL;
  if (rawLogLevel !== undefined && !LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new Error(
      `Invalid HERMES_MCP_LOG_LEVEL "${rawLogLevel}". Allowed values: ${LOG_LEVELS.join(", ")}.`
    );
  }

  const accessToken = env.HERMES_ACCESS_TOKEN;
  const storeId = env.HERMES_STORE_ID;
  if ((accessToken && !storeId) || (!accessToken && storeId)) {
    throw new Error("HERMES_ACCESS_TOKEN and HERMES_STORE_ID must be set together, or neither.");
  }

  // Optional, unlike the pair above. Without it a local run still works, it
  // just dies at the first expiry the way it always did; with it, a long CI
  // run or a day at a terminal survives one.
  const refreshToken = env.HERMES_REFRESH_TOKEN;
  if (refreshToken && !accessToken) {
    throw new Error("HERMES_REFRESH_TOKEN needs HERMES_ACCESS_TOKEN and HERMES_STORE_ID alongside it.");
  }

  return {
    logLevel: (rawLogLevel as LogLevel | undefined) ?? "info",
    serverName: "hermes-mcp",
    serverVersion: "0.2.0",
    hermesBaseUrl: env.HERMES_BASE_URL ?? "https://hermes-atlas.vjr-dev.com",
    openApiDocsUrl: env.HERMES_OPENAPI_DOCS_URL ?? "https://hermes-atlas.vjr-dev.com/v3/api-docs",
    openApiFetchTimeoutMs: 10_000,
    credentials:
      accessToken && storeId
        ? { accessToken, storeId, ...(refreshToken ? { refreshToken } : {}) }
        : null,
    singleUser: env.HERMES_SINGLE_USER === "1",
    loginWaitMs: parseLoginWait(env.HERMES_LOGIN_WAIT_MS),
  };
};
