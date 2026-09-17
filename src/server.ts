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

/**
 * Builds a fully configured server without connecting it to a transport.
 * Kept separate from stdio setup so tests can drive a real server over
 * InMemoryTransport, matching vajro-custom-blocks-sdk/mcp's own pattern.
 */
export const createServer = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config)
): McpServer => {
  const registry = SchemaRegistry.fromDocument(loadSnapshotDoc());
  const server = new McpServer({ name: config.serverName, version: config.serverVersion });

  // Order matters: the tools must be registered before the refresh loop starts,
  // so the loop has a sync function to push refreshed schemas through.
  const syncToolSchemas = registerHermesTools(server, {
    config,
    logger,
    registry,
    createClient: (user) => new HermesClient(config.hermesBaseUrl, user),
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
