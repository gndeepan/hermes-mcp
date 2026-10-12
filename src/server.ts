#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { applyEnvFile } from "./envFile.js";
import { loadConfig, type HermesMcpConfig } from "./config.js";
import { createLogger, type Logger } from "./logging.js";
import { registerHermesTools } from "./tools/index.js";
import { SchemaRegistry } from "./registry/schemaRegistry.js";
import { OperationIndex } from "./registry/operations.js";
import { CredentialStore } from "./auth/credentialStore.js";
import { HttpHermesLogin } from "./auth/hermesLogin.js";
import type { AuthContext } from "./tools/setup.js";
import { loadSnapshotDoc } from "./registry/snapshot.js";
import { ENDPOINTS } from "./registry/endpoints.js";
import { primeRegistry } from "./openapiSync.js";
import { HermesClient } from "./hermesClient.js";
import { TokenCache } from "./tokenRefresh.js";
import type { OpenApiDocument } from "./registry/schemaFromOpenApi.js";
import type { HttpCredentials } from "./userContext.js";
import { invokedAs } from "./entry.js";

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
  /**
   * Renewed access tokens, shared by every call this process serves.
   *
   * Process-scoped for the same reason the registry is: per request, it would
   * be a cache that never hits, and every stale call would pay for its own
   * renewal. Sharing it is safe because entries are keyed by the SHA-256 of a
   * refresh token — the key is the secret, so only a caller already holding
   * that session can reach its entry. See `tokenRefresh.ts`.
   */
  tokens: TokenCache;
  /**
   * Every operation Hermes publishes, not just the twelve this server curates.
   *
   * Held apart from `registry` because they answer different questions.
   * `SchemaRegistry` compiles the allowlist and discards the document; the
   * gateway needs the document itself, and rebuilding it per request would mean
   * parsing 760 KB on every tool call.
   *
   * Mutable, unlike the rest of the runtime: a successful spec fetch replaces
   * it wholesale. Rebuilding is cheaper and far easier to reason about than
   * reconciling an index in place.
   */
  operations: OperationIndex;
  /** The document `operations` was built from, for resolving `$ref`s at search time. */
  doc: OpenApiDocument;
}

export const createRuntime = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config)
): ServerRuntime => {
  // Read once and shared: the registry and the index are two views of the same
  // document, and parsing it twice would be pure waste.
  const doc = loadSnapshotDoc();
  return {
    config,
    logger,
    registry: SchemaRegistry.fromDocument(doc),
    tokens: new TokenCache(config.hermesBaseUrl),
    operations: OperationIndex.fromDocument(doc),
    doc,
  };
};

/** What differs between one served unit and the next. */
export interface ServerOptions {
  /** Credentials from the HTTP request being served. Absent under stdio. */
  httpCredentials?: HttpCredentials;
  /**
   * The signed-in session this process owns, enabling `hermes_setup`.
   *
   * Passed only by the stdio entry, and only in single-user mode. The HTTP
   * entry never constructs one, which is what keeps hard constraint #2 intact
   * everywhere it still applies: a shared process cannot read or write a
   * credential file it has no handle to.
   */
  auth?: AuthContext;
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
  const { config, logger, registry, tokens } = runtime;
  const server = new McpServer({ name: config.serverName, version: config.serverVersion });

  const syncToolSchemas = registerHermesTools(server, {
    config,
    logger,
    registry,
    createClient: (user) => new HermesClient(config.hermesBaseUrl, user),
    tokens,
    // The runtime itself, not a copy: hermes_refresh_openapi replaces the
    // index, and a copy would leave the gateway on the startup document.
    specs: runtime,
    ...(options.httpCredentials === undefined
      ? {}
      : { httpCredentials: options.httpCredentials }),
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    allowEnvFallback: options.allowEnvFallback ?? true,
  });

  return { server, syncToolSchemas };
};

/**
 * A long-lived server, as stdio serves it.
 *
 * Owns the refresh loop, which a per-request server must not: the loop exists
 * to push a refreshed schema into a server that would otherwise keep
 * advertising the one it started with.
 *
 * No longer single-user. The ai-agent runs one of these as a child process and
 * serves every merchant through it, putting the caller's identity on each
 * call's `_meta`. So the environment fallback is off unless
 * `HERMES_SINGLE_USER=1` says this really is one person's process — left on in
 * a shared process, a call that lost its credentials would act as whatever
 * merchant is configured rather than failing.
 */
export const createServer = (
  config: HermesMcpConfig = loadConfig(),
  logger: Logger = createLogger(config),
  envFile: string | null = null
): McpServer => {
  const runtime = createRuntime(config, logger);

  // Order matters: the tools must be registered before the refresh loop starts,
  // so the loop has a sync function to push refreshed schemas through.
  // The login subsystem exists only where one signed-in user is the truth.
  const auth: AuthContext | undefined = config.singleUser
    ? {
        store: new CredentialStore(),
        login: new HttpHermesLogin(config.hermesBaseUrl),
        logger,
        pending: {},
        envFile,
      }
    : undefined;

  const { server, syncToolSchemas } = buildServer(runtime, {
    allowEnvFallback: config.singleUser,
    ...(auth === undefined ? {} : { auth }),
  });

  void primeRegistry(runtime, config, logger, () => {
    const changed = syncToolSchemas();
    if (changed.length > 0) {
      logger.info("re-advertised refreshed tool schemas", { changed });
    }
  });

  logger.info("server ready", { tools: ENDPOINTS.length + 1 });
  return server;
};

/* c8 ignore start — process entry point, covered by running the binary */
if (invokedAs("server.js")) {
  // Before anything reads the environment. A local single-user run keeps its
  // credentials in a gitignored `.env`, and a client config can only forward
  // variables that are already exported — so the file is read here or not at
  // all. A shared run is untouched: see `applyEnvFile`.
  const envFile = applyEnvFile();

  serveStdio(() => {
    const config = loadConfig();
    const logger = createLogger(config);
    // Named, never contents. "Which file did my credentials come from" is the
    // first question asked when they turn out to be the wrong ones.
    if (envFile !== null) logger.info("loaded env file", { path: envFile });
    return createServer(config, logger, envFile);
  });
}
/* c8 ignore stop */
