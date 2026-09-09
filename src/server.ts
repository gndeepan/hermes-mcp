#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, type HermesMcpConfig } from "./config.js";
import { createLogger, type Logger } from "./logging.js";
import { registerHermesTools } from "./tools/index.js";
import { SchemaRegistry } from "./registry/schemaRegistry.js";
import { loadSnapshotDoc } from "./registry/snapshot.js";
import { ENDPOINTS } from "./registry/endpoints.js";
import { startOpenApiRefreshLoop } from "./openapiSync.js";
import { HermesClient } from "./hermesClient.js";
import { createTokenStore, type StoredCredentials } from "./auth/tokenStore.js";
import { TokenManager } from "./auth/tokenManager.js";

/**
 * Prefers a persisted login; falls back to the static env-var credential.
 * The env-var form has no refresh token and no known expiry, so it is seeded
 * with an infinite expiry — never proactively refreshed, but still able to fail
 * cleanly into MissingCredentialsError if Hermes rejects it.
 */
const buildTokenManager = (config: HermesMcpConfig): TokenManager => {
  const store = createTokenStore();
  const fromEnv: StoredCredentials | null = config.credentials
    ? {
        accessToken: config.credentials.accessToken,
        storeId: config.credentials.storeId,
        refreshToken: "",
        expiresAt: Number.POSITIVE_INFINITY,
      }
    : null;
  return new TokenManager({ store, baseUrl: config.hermesBaseUrl }, store.read() ?? fromEnv);
};

/**
 * Builds a fully configured server without connecting it to a transport.
 * Kept separate from stdio setup so tests can drive a real server over
 * InMemoryTransport, matching vajro-custom-blocks-sdk/mcp's own pattern.
 */
export const createServer = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config),
  tokenManager: TokenManager = buildTokenManager(config)
): McpServer => {
  const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
  const server = new McpServer({ name: config.serverName, version: config.serverVersion });

  // Order matters: the tools must be registered before the refresh loop starts,
  // so the loop has a sync function to push refreshed schemas through.
  const syncToolSchemas = registerHermesTools(server, {
    config,
    logger,
    tokenManager,
    registry,
    createClient: (credentials) => new HermesClient(config.hermesBaseUrl, credentials),
  });

  startOpenApiRefreshLoop(registry, config, logger, () => {
    const changed = syncToolSchemas();
    if (changed.length > 0) {
      logger.info("re-advertised refreshed tool schemas", { changed });
    }
  });

  logger.info("server ready", { tools: ENDPOINTS.length + 1 });
  return server;
};

/* c8 ignore start — process entry point, covered by running the binary */
if (process.argv[1]?.endsWith("server.js")) {
  serveStdio(() => createServer());
}
/* c8 ignore stop */
