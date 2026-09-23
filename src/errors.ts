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

/**
 * No usable answer from Hermes: either none came back, or Hermes answered with
 * a 5xx. Both are worth retrying, so they share a type; they do not share a
 * message. "Unreachable" for a 500 sends someone checking their network when
 * Hermes answered perfectly well and failed on its own side — so a server
 * error says so, with the detail Hermes gave.
 */
export class HermesUnavailableError extends Error {
  constructor(
    readonly path: string,
    readonly cause: unknown,
    readonly status?: number
  ) {
    super(
      status === undefined
        ? `Hermes is unreachable calling ${path}: ${errorMessage(cause)}`
        : `Hermes failed with ${status} on ${path}: ${errorMessage(cause)}`
    );
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
        "Over HTTP, send the end user's own token as `Authorization: Bearer <token>`",
        "with their store in the `X-Store-Id` header (and optionally `X-Request-ID`).",
        "Over stdio, send the same values in this request's `_meta`:",
        '"com.superfans.hermes/accessToken" and "com.superfans.hermes/storeId"',
        '(optionally "com.superfans.hermes/requestId").',
        "HERMES_ACCESS_TOKEN and HERMES_STORE_ID are a single-user local fallback and are",
        "ignored by the shared HTTP service, where acting as the environment would mean",
        "acting as the wrong merchant.",
      ].join(" ")
    );
    this.name = "MissingCredentialsError";
  }
}

/**
 * The session is over, and no credential this server can reach will revive it.
 *
 * Distinct from `HermesUnauthenticatedError` on purpose, and the distinction is
 * the only reason renewal is worth having a separate error for. A plain 401
 * says "that token was not accepted", which a renewal may well fix and which
 * the caller can do nothing about. This says the renewal was tried and Hermes
 * refused the refresh token too — so there is exactly one remedy, the merchant
 * signs in again, and the caller can act on that rather than retrying.
 */
export class SessionExpiredError extends Error {
  constructor(readonly detail: string) {
    super(
      "The Hermes session has expired and could not be renewed" +
        `${detail === "" ? "" : `: ${detail}`}. The refresh token is no longer accepted, ` +
        "so the merchant must sign in again to get a new one."
    );
    this.name = "SessionExpiredError";
  }
}

/**
 * A sign-in was started on the user's behalf, and has not finished yet.
 *
 * Raised only in a single-user process, and only once the browser is already
 * open: the call waited as long as a client will reasonably hold a tool call
 * open, and the user is still typing their code. The message carries the URL
 * (which holds a nonce, not a credential) so the model can hand it over if the
 * browser did not open, and says the one thing to do next — call again, which
 * joins the same sign-in rather than starting another.
 */
export class SignInRequiredError extends Error {
  constructor(readonly url: string, readonly opened: boolean) {
    super(
      (opened
        ? `Opened the user's browser to sign in to Hermes: ${url}`
        : `Could not open a browser automatically. Ask the user to open this URL and sign in: ${url}`) +
        " — the sign-in has not finished yet. Tell the user to complete it in the browser (email, then the " +
        "one-time code, then their store), then call this same tool again with the same arguments. " +
        "The sign-in link is good for 5 minutes."
    );
    this.name = "SignInRequiredError";
  }
}

/**
 * A call that names one store as an argument while authenticating as another.
 *
 * `storeId` arrives twice on the store-scoped tools: once as a tool argument
 * that steers the path, and once as the authenticated identity behind the
 * token. Nothing made them agree. Hermes would very likely refuse the
 * mismatch, but "very likely" is not a tenant boundary — and on a shared
 * multi-user process the cost of being wrong is one merchant reading another's
 * blocks. Refused here, before the wire.
 */
export class StoreMismatchError extends Error {
  constructor(
    readonly argumentStoreId: string,
    readonly authenticatedStoreId: string
  ) {
    super(
      `Refusing the call: it names storeId "${argumentStoreId}" but authenticates as ` +
        `"${authenticatedStoreId}". A call may only act on the store it is authenticated for.`
    );
    this.name = "StoreMismatchError";
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
  [SessionExpiredError, "SESSION_EXPIRED"],
  [SignInRequiredError, "SIGN_IN_REQUIRED"],
  [StoreMismatchError, "STORE_MISMATCH"],
  [InvalidPathParameterError, "INVALID_PATH_PARAM"],
  // Defined since the allowlist compiler needed it, but never mapped — so a
  // caller naming an operation the document does not have got "The tool failed
  // unexpectedly. Reference <hex>", which is accurate about nothing and
  // actionable by no one. The gateway makes this a routine, correctable answer.
  [MissingOperationError, "UNKNOWN_OPERATION"],
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
