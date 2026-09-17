#!/usr/bin/env node
/**
 * The multi-user entry: one process, many merchants, one request at a time.
 *
 * Every request carries its own credentials and is served by its own short-lived
 * server instance, so there is nothing for one merchant's request to leave
 * behind for the next. The stateless posture is the point — a session would be
 * shared state, and shared state between tenants is the thing this must not
 * have.
 *
 * The environment fallback is off here, unconditionally unless explicitly
 * re-enabled. On stdio the environment *is* the single user; on a shared
 * service it is whatever happened to be exported when the process started, and
 * a request that forgot its credentials would silently act as that merchant.
 * That failure returns data and looks exactly like success, which is why it is
 * closed structurally rather than by remembering a flag.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { ENDPOINTS } from "./registry/endpoints.js";
import { startOpenApiRefreshLoop } from "./openapiSync.js";
import { buildServer, createRuntime, type ServerRuntime } from "./server.js";
import type { HttpCredentials } from "./userContext.js";

/** How a merchant identifies itself to this service. */
const STORE_HEADER = "x-store-id";
const REQUEST_ID_HEADER = "x-request-id";

/**
 * Reads the caller's identity off the HTTP request.
 *
 * Deliberately returns a value even when incomplete: `userContextFrom` owns the
 * "is this enough to act as someone" decision, and duplicating it here would
 * give two places to disagree. What this must not do is fall through to another
 * source — an HTTP request that carried a header is asserting an identity, and
 * a half-filled one is refused rather than completed.
 */
export const credentialsFrom = (headers: Headers): HttpCredentials | undefined => {
  const authorization = headers.get("authorization") ?? "";
  const storeId = headers.get(STORE_HEADER) ?? "";
  const requestId = headers.get(REQUEST_ID_HEADER) ?? "";

  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const accessToken = bearer?.[1]?.trim() ?? "";

  if (accessToken === "" && storeId === "") return undefined;
  return {
    accessToken,
    storeId: storeId.trim(),
    ...(requestId === "" ? {} : { requestId: requestId.trim() }),
  };
};

export interface HttpEntryOptions {
  runtime?: ServerRuntime;
  /**
   * Allow the environment credential to serve a request that brought none.
   *
   * Off by default and only ever turned on for a local single-user run. See the
   * module comment for why this is not a convenience.
   */
  allowEnvFallback?: boolean;
}

/**
 * The fetch-shaped handler, for a Node server or any Web-standard host.
 *
 * `createMcpHandler` performs no token verification of its own — credentials are
 * strictly pass-through — so the factory reads them from the request and hands
 * them to the per-request server. Verification is Hermes's job: this service
 * holds no identity and cannot mint or check a token, so a bad one comes back
 * as Hermes's own 401 rather than a guess made here.
 */
export const createHandler = (options: HttpEntryOptions = {}) => {
  const runtime = options.runtime ?? createRuntime();

  return createMcpHandler((ctx) => {
    const credentials =
      ctx.requestInfo === undefined ? undefined : credentialsFrom(ctx.requestInfo.headers);

    const { server } = buildServer(runtime, {
      ...(credentials === undefined ? {} : { httpCredentials: credentials }),
      allowEnvFallback: options.allowEnvFallback ?? false,
    });
    return server;
  });
};

/* c8 ignore start — process entry point, covered by running the binary */
if (process.argv[1]?.endsWith("httpServer.js")) {
  const config = loadConfig();
  const logger = createLogger(config);
  const runtime = createRuntime(config, logger);

  // Hoisted out of the per-request factory on purpose. Inside it, every request
  // would start its own timer and its own outbound spec fetch.
  startOpenApiRefreshLoop(runtime.registry, config, logger, () => {
    // Nothing to re-advertise: each request builds a server that reads the
    // current registry, so a refreshed schema is live on the very next call.
  });

  const handler = createHandler({ runtime });
  const port = Number(process.env.PORT ?? 8787);

  createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await new Promise<string>((resolve) => {
              let text = "";
              req.on("data", (chunk) => {
                text += String(chunk);
              });
              req.on("end", () => resolve(text));
            });

      const request = new Request(url, {
        method: req.method ?? "GET",
        headers: Object.entries(req.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value] as [string, string]]
        ),
        ...(body === undefined || body === "" ? {} : { body }),
      });

      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(response.body === null ? undefined : Buffer.from(await response.arrayBuffer()));
    })().catch((cause: unknown) => {
      logger.error("http request failed", { error: cause instanceof Error ? cause.message : String(cause) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }).listen(port, () => {
    logger.info("hermes-mcp listening", {
      port,
      tools: ENDPOINTS.length + 1,
      envFallback: "disabled",
    });
  });
}
/* c8 ignore stop */
