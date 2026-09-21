import type { EnvCredentials } from "./userContext.js";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

export interface HermesMcpConfig {
  logLevel: LogLevel;
  serverName: string;
  serverVersion: string;
  hermesBaseUrl: string;
  openApiDocsUrl: string;
  openApiRefreshIntervalS: number;
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
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): HermesMcpConfig => {
  const rawLogLevel = env.HERMES_MCP_LOG_LEVEL;
  if (rawLogLevel !== undefined && !LOG_LEVELS.includes(rawLogLevel as LogLevel)) {
    throw new Error(
      `Invalid HERMES_MCP_LOG_LEVEL "${rawLogLevel}". Allowed values: ${LOG_LEVELS.join(", ")}.`
    );
  }

  const rawInterval = env.HERMES_OPENAPI_REFRESH_INTERVAL_S;
  const openApiRefreshIntervalS = rawInterval === undefined ? 900 : Number(rawInterval);
  if (!Number.isFinite(openApiRefreshIntervalS) || openApiRefreshIntervalS <= 0) {
    throw new Error(
      `Invalid HERMES_OPENAPI_REFRESH_INTERVAL_S "${rawInterval}". Must be a positive number of seconds.`
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
    serverVersion: "0.1.0",
    hermesBaseUrl: env.HERMES_BASE_URL ?? "https://hermes-atlas.vjr-dev.com",
    openApiDocsUrl: env.HERMES_OPENAPI_DOCS_URL ?? "https://hermes-atlas.vjr-dev.com/v3/api-docs",
    openApiRefreshIntervalS,
    openApiFetchTimeoutMs: 10_000,
    credentials:
      accessToken && storeId
        ? { accessToken, storeId, ...(refreshToken ? { refreshToken } : {}) }
        : null,
    singleUser: env.HERMES_SINGLE_USER === "1",
  };
};
