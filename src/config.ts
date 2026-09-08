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
  credentials: { accessToken: string; storeId: string } | null;
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

  return {
    logLevel: (rawLogLevel as LogLevel | undefined) ?? "info",
    serverName: "hermes-mcp",
    serverVersion: "0.1.0",
    hermesBaseUrl: env.HERMES_BASE_URL ?? "https://hermes-atlas.vjr-dev.com",
    openApiDocsUrl: env.HERMES_OPENAPI_DOCS_URL ?? "https://hermes-atlas.vajro.com/v3/api-docs",
    openApiRefreshIntervalS,
    openApiFetchTimeoutMs: 10_000,
    credentials: accessToken && storeId ? { accessToken, storeId } : null,
  };
};
