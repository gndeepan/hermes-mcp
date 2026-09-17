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
import type { HttpCredentials } from "./userContext.js";

/**
 * The pieces that belong to the process, not to a request.
 *
 * Built once and passed in. Under stdio that is merely tidy; under HTTP it is
 * load-bearing, because the server is constructed per request — leaving the
 * registry in here would mean one snapshot read, one refresh timer and one
 * outbound OpenAPI fetch *per request*.
 */
export interface ServerRuntime {
  config: HermesMcpConfig;
  logger: Logger;
  registry: SchemaRegistry;
}

export const createRuntime = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config)
): ServerRuntime => ({
  config,
  logger,
  registry: SchemaRegistry.fromDocument(loadSnapshotDoc()),
});

/** What differs between one served unit and the next. */
export interface ServerOptions {
  /** Credentials from the HTTP request being served. Absent under stdio. */
  httpCredentials?: HttpCredentials;
  /**
   * Whether a call carrying no credentials may fall back to the environment.
   *
   * Defaults to true, which is right for stdio: one process serves one user,
   * so the environment *is* that user. The HTTP entry passes false.
   */
  allowEnvFallback?: boolean;
}

/**
 * Builds a fully configured server without connecting it to a transport.
 * Kept separate from stdio setup so tests can drive a real server over
 * InMemoryTransport, matching vajro-custom-blocks-sdk/mcp's own pattern.
 *
 * Returns the server and the schema-sync function, because whether re-advertising
 * matters depends on the transport: a long-lived stdio server holds whatever
 * schema it was handed at registration and must be pushed a refreshed one, while
 * a per-request HTTP server reads the current registry every time and needs no
 * push at all.
 */
export const buildServer = (
  runtime: ServerRuntime,
  options: ServerOptions = {}
): { server: McpServer; syncToolSchemas: () => string[] } => {
  const { config, logger, registry } = runtime;
  const server = new McpServer({ name: config.serverName, version: config.serverVersion });

  const syncToolSchemas = registerHermesTools(server, {
    config,
    logger,
    registry,
    createClient: (user) => new HermesClient(config.hermesBaseUrl, user),
    ...(options.httpCredentials === undefined
      ? {}
      : { httpCredentials: options.httpCredentials }),
    allowEnvFallback: options.allowEnvFallback ?? true,
  });

  return { server, syncToolSchemas };
};

/**
 * A long-lived single-user server, as stdio serves it.
 *
 * Owns the refresh loop, which a per-request server must not: the loop exists
 * to push a refreshed schema into a server that would otherwise keep
 * advertising the one it started with.
 */
export const createServer = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config)
): McpServer => {
  const runtime = createRuntime(config, logger);

  // Order matters: the tools must be registered before the refresh loop starts,
  // so the loop has a sync function to push refreshed schemas through.
  const { server, syncToolSchemas } = buildServer(runtime);

  startOpenApiRefreshLoop(runtime.registry, config, logger, () => {
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
