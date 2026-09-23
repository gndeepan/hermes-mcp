import { MissingCredentialsError } from "./errors.js";
import { toEpochMillis } from "./tokenRefresh.js";

/**
 * The credential namespace this server reads out of a tool call's `_meta`.
 *
 * MCP reserves `io.modelcontextprotocol/*` inside `_meta` for the protocol
 * itself and leaves every other reverse-DNS namespace to the application, so
 * these keys can never collide with a future spec key.
 */
export const META_NAMESPACE = "com.superfans.hermes/";

export const ACCESS_TOKEN_KEY = `${META_NAMESPACE}accessToken`;
export const STORE_ID_KEY = `${META_NAMESPACE}storeId`;
export const REQUEST_ID_KEY = `${META_NAMESPACE}requestId`;

/**
 * The renewal credentials, both optional.
 *
 * A caller that sends neither gets exactly the behaviour this server had
 * before they existed: a rejected token is reported as a rejected token. A
 * caller that sends a refresh token is granting this server permission to
 * renew its session on its behalf, and `expiresAt` lets that happen *before* a
 * call fails rather than after.
 */
export const REFRESH_TOKEN_KEY = `${META_NAMESPACE}refreshToken`;
export const EXPIRES_AT_KEY = `${META_NAMESPACE}expiresAt`;

/**
 * Who a single tool call acts as.
 *
 * Built per call from that call's `_meta` and never cached, exactly like the
 * AI Server's own `UserContext` (`ai-server/src/ai_server/context/hermes_client.py`):
 * the credential belongs to a request, never to the process, so one caller's
 * token can never be used to serve another caller's request. This server holds
 * no identity of its own — it carries the end user's, and therefore can only
 * ever read and write what that user could already read and write.
 */
export interface UserContext {
  accessToken: string;
  storeId: string;
  /** Propagated as `X-Request-ID` so one trace can be followed caller -> MCP -> Hermes. */
  requestId?: string;
  /**
   * Permission to renew this session, and the means to do it. Absent unless
   * the caller chose to grant it.
   */
  refreshToken?: string;
  /** When `accessToken` dies, in epoch milliseconds. Only meaningful with a refresh token. */
  expiresAt?: number;
}

/** The Hermes headers a user context turns into. The only place they are spelled out. */
export const headersFor = (user: UserContext): Record<string, string> => ({
  Authorization: `Bearer ${user.accessToken}`,
  "X-Store-Id": user.storeId,
  Accept: "application/json",
  ...(user.requestId ? { "X-Request-ID": user.requestId } : {}),
});

/**
 * Coerces one `_meta` value to a credential string.
 *
 * A store id that looks numeric is routinely *sent* as a JSON number rather
 * than a string — the MCP Inspector's `--tool-metadata storeId=1234` does
 * exactly that, because it JSON-parses every `key=value` pair. Accepting only
 * a string would refuse a perfectly well-formed identity and report it as "no
 * credentials", which points the caller at the wrong problem entirely.
 *
 * Only scalars are accepted. An object, array, boolean or null is not an
 * identifier under any reading, so it yields "" and fails closed.
 */
const asNonEmptyString = (value: unknown): string => {
  if (typeof value === "string") return value.trim() === "" ? "" : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

/**
 * Reads a namespaced key, falling back to the bare name.
 *
 * The namespaced form is the contract a client should send; the bare form is
 * accepted because it is what a human typing a call by hand reaches for first,
 * and refusing it would fail as "no credentials" with the credentials sitting
 * right there in the request.
 */
const readMeta = (meta: Record<string, unknown> | undefined, key: string, bare: string): string =>
  asNonEmptyString(meta?.[key]) || asNonEmptyString(meta?.[bare]);

const hasMeta = (meta: Record<string, unknown> | undefined, key: string, bare: string): boolean =>
  meta !== undefined && (key in meta || bare in meta);

/**
 * Whether this call's `_meta` names an identity of its own.
 *
 * Such a call belongs to its caller, not to whoever is signed in on this
 * machine, so nothing done on the fallback's behalf — a browser sign-in above
 * all — may be done for it.
 */
export const callAssertsIdentity = (meta: Record<string, unknown> | undefined): boolean =>
  hasMeta(meta, ACCESS_TOKEN_KEY, "accessToken") || hasMeta(meta, STORE_ID_KEY, "storeId");

/**
 * The single-user environment identity, which may now also carry a refresh
 * token so a long local run does not die at the first expiry.
 */
export interface EnvCredentials {
  accessToken: string;
  storeId: string;
  refreshToken?: string;
  /**
   * When the access token dies, in epoch milliseconds.
   *
   * The environment never knows this — a token pasted into `.env` carries no
   * expiry — but a session restored from `hermes_setup` does, and without it a
   * stored session could only be renewed *after* a call had already failed.
   * Optional for exactly that reason: present for a signed-in session, absent
   * for a pasted token.
   */
  expiresAt?: number;
}

/**
 * The renewal half of an identity, as the fields to spread onto it.
 *
 * `expiresAt` without a refresh token is dropped rather than kept: nothing can
 * act on knowing a token is about to die if there is no way to renew it, and
 * carrying it would only invite a later reader to treat "expired" as a
 * decision point when the only honest answer is still to send the token and
 * let Hermes rule on it.
 */
const renewalFrom = (
  refreshToken: string | undefined,
  expiresAt: unknown
): { refreshToken?: string; expiresAt?: number } => {
  const token = (refreshToken ?? "").trim();
  if (token === "") return {};
  const millis = toEpochMillis(expiresAt);
  return { refreshToken: token, ...(millis === undefined ? {} : { expiresAt: millis }) };
};

/**
 * Credentials taken from the HTTP request that carried this call.
 *
 * Populated by the HTTP entry from the `Authorization` bearer token and the
 * `X-Store-Id` header, which is how a standard MCP client authenticates. Kept
 * as a plain shape rather than the SDK's `AuthInfo` so this module stays
 * transport-free and unit-testable.
 */
export interface HttpCredentials {
  accessToken: string;
  storeId: string;
  requestId?: string;
  refreshToken?: string;
  /** Epoch milliseconds, already normalized by whoever read the header. */
  expiresAt?: number;
}

/**
 * Builds the identity for one tool call.
 *
 * Three sources, in order of how specific they are to *this* request:
 *
 * 1. **HTTP** — the bearer token on the request that carried the call. This is
 *    how a standard MCP client authenticates, so it wins.
 * 2. **`_meta`** — the in-band credential a Superfans client attaches to the
 *    call itself. Retained because it is what the stdio transport has; there is
 *    no HTTP request under stdio to take a header from.
 * 3. **The environment** — a single-user fallback for local runs and CI. The
 *    HTTP entry passes `null` here, because in a shared process a request that
 *    forgot its credentials must fail rather than silently act as whatever
 *    merchant happens to be in the environment.
 *
 * Having none of the three is a caller error, not a server fault — surfaced as
 * `MISSING_CREDENTIALS` naming the keys to send, and nothing reaches Hermes.
 *
 * The token and the store id are resolved as one unit, never field by field. A
 * source that names either one is asserting an identity of its own, so a
 * half-filled source is refused outright rather than completed from the next
 * one down — otherwise a caller who sent only a token would act with their own
 * credential against someone else's store, which is both a wrong answer and a
 * cross-tenant one.
 */
export const userContextFrom = (
  meta: Record<string, unknown> | undefined,
  http: HttpCredentials | undefined,
  fallback: EnvCredentials | null
): UserContext => {
  if (http !== undefined) {
    if (!http.accessToken || !http.storeId) throw new MissingCredentialsError();
    return {
      accessToken: http.accessToken,
      storeId: http.storeId,
      ...(http.requestId ? { requestId: http.requestId } : {}),
      ...renewalFrom(http.refreshToken, http.expiresAt),
    };
  }

  const callAsserts = callAssertsIdentity(meta);

  const accessToken = callAsserts
    ? readMeta(meta, ACCESS_TOKEN_KEY, "accessToken")
    : (fallback?.accessToken ?? "");
  const storeId = callAsserts ? readMeta(meta, STORE_ID_KEY, "storeId") : (fallback?.storeId ?? "");
  if (!accessToken || !storeId) throw new MissingCredentialsError();

  const requestId = readMeta(meta, REQUEST_ID_KEY, "requestId");
  // From the same source as the access token, never mixed. The env's refresh
  // token belongs to the env's session; using it to renew a session the call
  // asserted for itself would hand this call a different user's credential.
  const renewal = callAsserts
    ? renewalFrom(readMeta(meta, REFRESH_TOKEN_KEY, "refreshToken"), readMeta(meta, EXPIRES_AT_KEY, "expiresAt"))
    : renewalFrom(fallback?.refreshToken, fallback?.expiresAt);

  return { accessToken, storeId, ...(requestId ? { requestId } : {}), ...renewal };
};
