import { randomBytes } from "node:crypto";
import type { Logger } from "./logging.js";

export class HermesUnauthenticatedError extends Error {
  constructor(readonly path: string) {
    super(`Hermes rejected the request as unauthenticated: ${path}`);
    this.name = "HermesUnauthenticatedError";
  }
}

export class HermesForbiddenError extends Error {
  constructor(readonly path: string) {
    super(`Hermes rejected the request as forbidden: ${path}`);
    this.name = "HermesForbiddenError";
  }
}

export class HermesNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Not found: ${path}`);
    this.name = "HermesNotFoundError";
  }
}

export class HermesRejectedError extends Error {
  constructor(readonly path: string, readonly status: number, readonly body: string) {
    super(`Hermes rejected the request to ${path} (${status}): ${body}`);
    this.name = "HermesRejectedError";
  }
}

export class HermesUnavailableError extends Error {
  constructor(readonly path: string, readonly cause: unknown) {
    super(`Hermes is unreachable calling ${path}: ${errorMessage(cause)}`);
    this.name = "HermesUnavailableError";
  }
}

/**
 * No identity for this call. This server holds no credential of its own, so
 * this is always the caller's omission — the message names exactly what to
 * send rather than pointing at server-side state the caller cannot inspect.
 */
export class MissingCredentialsError extends Error {
  constructor() {
    // The key names are spelled out rather than imported from `userContext`,
    // which imports this module. `test/userContext.test.ts` asserts the two
    // stay in step, so a renamed key cannot leave this message stale.
    super(
      [
        "This tool call carried no Hermes credentials.",
        "Send the end user's own credentials in this request's `_meta`:",
        '"com.superfans.hermes/accessToken" and "com.superfans.hermes/storeId"',
        '(optionally "com.superfans.hermes/requestId" for tracing).',
        "For a single-user local run, set HERMES_ACCESS_TOKEN and HERMES_STORE_ID instead.",
      ].join(" ")
    );
    this.name = "MissingCredentialsError";
  }
}

/**
 * A path parameter that cannot be safely substituted into an allowlisted path
 * template. Visible to the caller on purpose: either they passed a value that
 * would steer the request off the allowlisted path (a dot-only segment, which
 * `new URL()` resolves away), or a live schema refresh dropped a path
 * parameter and left its placeholder unsubstituted. Both are correctable, and
 * neither may be allowed to reach Hermes.
 */
export class InvalidPathParameterError extends Error {
  constructor(readonly pathTemplate: string, readonly detail: string) {
    super(`Refusing to call ${pathTemplate}: ${detail}`);
    this.name = "InvalidPathParameterError";
  }
}

export class MissingOperationError extends Error {
  constructor(readonly toolName: string, readonly method: string, readonly pathTemplate: string) {
    super(`${toolName}: ${method.toUpperCase()} ${pathTemplate} is not present in the OpenAPI spec`);
    this.name = "MissingOperationError";
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ToolResult {
  content: [{ type: "text"; text: string }];
  isError: true;
}

const KNOWN_ERROR_CODES: [new (...args: never[]) => Error, string][] = [
  [HermesUnauthenticatedError, "UNAUTHENTICATED"],
  [HermesForbiddenError, "FORBIDDEN"],
  [HermesNotFoundError, "NOT_FOUND"],
  [HermesRejectedError, "REJECTED"],
  [HermesUnavailableError, "UNAVAILABLE"],
  [MissingCredentialsError, "MISSING_CREDENTIALS"],
  [InvalidPathParameterError, "INVALID_PATH_PARAM"],
];

/**
 * A known HermesError (or a missing-credentials/missing-operation error) is a
 * legitimate answer the caller needs to see, so it is surfaced with real detail.
 * Anything else is treated as an unexpected internal fault: logged in full, but
 * hidden from the caller behind a correlation id.
 */
export const toToolResult = (error: unknown, logger: Logger, tool: string): ToolResult => {
  for (const [ctor, code] of KNOWN_ERROR_CODES) {
    if (error instanceof ctor) {
      logger.warn("tool call rejected", { tool, code, error: errorMessage(error) });
      return { content: [{ type: "text", text: `[${code}] ${errorMessage(error)}` }], isError: true };
    }
  }

  const requestId = randomBytes(4).toString("hex");
  logger.error("tool call failed unexpectedly", {
    tool,
    requestId,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
  return {
    content: [
      { type: "text", text: `The tool failed unexpectedly. Reference ${requestId} in the server logs.` },
    ],
    isError: true,
  };
};
