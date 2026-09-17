import { MissingCredentialsError } from "./errors.js";

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
 * Builds the identity for one tool call.
 *
 * `_meta` wins over the environment: the env credential is a single-user
 * fallback for local runs and CI, whereas `_meta` is what a real client sends
 * per request. Having neither is a caller error, not a server fault — it is
 * surfaced as `MISSING_CREDENTIALS` naming the keys to send, and nothing
 * reaches Hermes.
 *
 * The token and the store id are resolved as one unit, never field by field.
 * A call that names either one is asserting an identity of its own, so a
 * half-filled `_meta` is refused outright rather than completed from the
 * environment — otherwise a caller who sent only a token would act with their
 * own credential against the *environment's* store, which is both a wrong
 * answer and a cross-tenant one.
 */
export const userContextFrom = (
  meta: Record<string, unknown> | undefined,
  fallback: { accessToken: string; storeId: string } | null
): UserContext => {
  const callAsserts =
    hasMeta(meta, ACCESS_TOKEN_KEY, "accessToken") || hasMeta(meta, STORE_ID_KEY, "storeId");

  const accessToken = callAsserts
    ? readMeta(meta, ACCESS_TOKEN_KEY, "accessToken")
    : (fallback?.accessToken ?? "");
  const storeId = callAsserts ? readMeta(meta, STORE_ID_KEY, "storeId") : (fallback?.storeId ?? "");
  if (!accessToken || !storeId) throw new MissingCredentialsError();

  const requestId = readMeta(meta, REQUEST_ID_KEY, "requestId");
  return { accessToken, storeId, ...(requestId ? { requestId } : {}) };
};
