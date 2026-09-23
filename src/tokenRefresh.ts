import { createHash } from "node:crypto";
import { HermesUnavailableError, SessionExpiredError } from "./errors.js";

/** Hermes's own session-renewal endpoint. Authenticates by the body, not a header. */
const AUTH_REFRESH_PATH = "/api/v1/auth/refresh";

/**
 * How long before its stated expiry a token is treated as already dead.
 *
 * A token that expires in four seconds is not usable: the request still has to
 * cross the network, and the clock here is not the clock at Hermes. Renewing
 * early costs one round trip that was going to happen anyway; renewing late
 * costs the merchant a failed action.
 */
export const EXPIRY_SKEW_MS = 60_000;

/** Enough sessions for a busy shared process, few enough to bound memory. */
const DEFAULT_MAX_ENTRIES = 500;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Below this, a timestamp cannot be milliseconds — it would be 1970. Hermes
 * documents `expiresAt` as epoch milliseconds and sends them, but the value
 * also reaches this server through a caller's `_meta`, where a seconds-based
 * clock is an easy mistake to make. Read as milliseconds, a seconds value is
 * always in the distant past, so the token would be refreshed on every single
 * call — slow, and silently so.
 */
const MILLIS_THRESHOLD = 1e12;

/** Normalizes an epoch timestamp to milliseconds, or returns undefined if it is not one. */
export const toEpochMillis = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return n < MILLIS_THRESHOLD ? Math.round(n * 1000) : Math.round(n);
};

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Renews one session against Hermes.
 *
 * Deliberately not a `HermesClient` call. The client exists to carry a user
 * context's headers, and this request has no user context to carry — the
 * refresh token in the body *is* the credential, and attaching the dead access
 * token alongside it would only invite Hermes to judge the request by the
 * wrong one.
 *
 * The failure split is the part that matters. A rejected refresh token means
 * the session is genuinely over and the merchant must sign in again. A
 * timeout or a 500 means nothing about the session at all, and reporting it as
 * an expired session would send a perfectly signed-in merchant back to a login
 * screen to fix a problem that was never theirs.
 */
export const refreshAccessToken = async (
  baseUrl: string,
  refreshToken: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<SessionTokens> => {
  const url = new URL(AUTH_REFRESH_PATH, baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new HermesUnavailableError(`${url.origin}${AUTH_REFRESH_PATH}`, err);
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    throw new HermesUnavailableError(
      AUTH_REFRESH_PATH,
      new Error(`Hermes returned ${response.status}`)
    );
  }
  if (response.status >= 400) throw new SessionExpiredError(await response.text());

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    throw new SessionExpiredError("the response was not JSON");
  }

  const data = (
    payload && typeof payload === "object" && "data" in payload
      ? (payload as { data: unknown }).data
      : payload
  ) as Record<string, unknown> | null;

  const accessToken = asString(data?.accessToken);
  // No token in a 200 is not a parse problem to hand back as an internal
  // fault: whatever Hermes meant by it, this session cannot continue.
  if (accessToken === "") throw new SessionExpiredError("the response carried no access token");

  return {
    accessToken,
    // Hermes may or may not rotate the refresh token. When it does not, the
    // one we sent is still the live one, and dropping it here would end the
    // session at the next renewal.
    refreshToken: asString(data?.refreshToken) || refreshToken,
    expiresAt: toEpochMillis(data?.expiresAt) ?? Date.now() + EXPIRY_SKEW_MS,
  };
};

export interface TokenCacheOptions {
  maxEntries?: number;
  timeoutMs?: number;
}

/**
 * The renewed access tokens this process is holding, keyed by refresh token.
 *
 * This server is otherwise strictly stateless between calls, and that is a
 * tenant-safety property, not tidiness — so it is worth being exact about why
 * this is safe. The key is the SHA-256 of the refresh token, which means **the
 * key is the secret**: an entry is reachable only by a caller who already
 * holds the refresh token that produced it, and therefore already holds the
 * session. Nothing here widens what anyone can reach. The raw token is never a
 * map key, never logged, and never leaves this module.
 *
 * Without the cache, every call made with a stale token pays a second full
 * round trip to Hermes, because the caller keeps sending the copy it has.
 */
export class TokenCache {
  readonly #entries = new Map<string, SessionTokens>();
  /** One renewal per session in flight, so ten concurrent calls make one request. */
  readonly #inFlight = new Map<string, Promise<SessionTokens>>();
  readonly #maxEntries: number;
  readonly #timeoutMs: number;
  /** Bumped by `clear`, so a renewal started before a logout is not stored after it. */
  #generation = 0;

  constructor(
    private readonly baseUrl: string,
    options: TokenCacheOptions = {}
  ) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * A live access token for this session, renewing only if one is needed.
   *
   * `force` is for the 401 path: Hermes has just rejected a token this cache
   * may believe is fine (its clock, a revocation, a restart), so the cached
   * answer is known-wrong and must not be handed back.
   */
  async accessTokenFor(
    refreshToken: string,
    options: { force?: boolean } = {}
  ): Promise<SessionTokens> {
    const key = keyOf(refreshToken);

    if (options.force === true) {
      this.#entries.delete(key);
    } else {
      const hit = this.#entries.get(key);
      if (hit !== undefined && !isStale(hit)) return hit;
      this.#entries.delete(key);
    }

    // A renewal already running for this session produces exactly the token
    // this call wants, so join it rather than start a second one.
    const flight = this.#inFlight.get(key);
    if (flight !== undefined) return flight;

    const generation = this.#generation;
    const started = (async () => {
      try {
        const tokens = await refreshAccessToken(this.baseUrl, refreshToken, this.#timeoutMs);
        if (generation === this.#generation) this.#remember(key, tokens);
        return tokens;
      } finally {
        // Always, including on failure: a failed renewal must not be cached as
        // an answer, or one network blip would keep a session down.
        this.#inFlight.delete(key);
      }
    })();

    this.#inFlight.set(key, started);
    return started;
  }

  /**
   * Forgets every renewed token, for `hermes_logout`.
   *
   * Renewals in flight are left to finish: they are shared promises other
   * calls may be awaiting, and each removes itself from the map when done. The
   * tokens they produce are simply never remembered: each renewal notes the
   * generation it started in, and a `clear` since then means it stores nothing.
   */
  clear(): void {
    this.#entries.clear();
    this.#generation += 1;
  }

  /** Entries held, counting both spellings of a rotated session. Diagnostics only. */
  get size(): number {
    return this.#entries.size;
  }

  /** The hashed keys, for tests asserting no raw secret is used as one. */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  #remember(requestKey: string, tokens: SessionTokens): void {
    this.#entries.set(requestKey, tokens);
    // Also under the token Hermes just handed back. When Hermes rotates, the
    // caller's next call carries the new refresh token, and without this that
    // call would be a miss and pay for a renewal it does not need.
    this.#entries.set(keyOf(tokens.refreshToken), tokens);

    // A Map iterates in insertion order, so the first key is the least
    // recently stored. Good enough: this bounds memory, it is not an LRU.
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}

const keyOf = (refreshToken: string): string =>
  createHash("sha256").update(refreshToken).digest("hex");

/** Whether a held token is too close to expiry to start a request with. */
export const isStale = (tokens: SessionTokens): boolean =>
  Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS;
