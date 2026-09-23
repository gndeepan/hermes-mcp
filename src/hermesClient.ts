import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
} from "./errors.js";
import { headersFor, type UserContext } from "./userContext.js";

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
}

export interface HermesRequester {
  request(method: string, path: string, options?: RequestOptions): Promise<unknown>;
}

/**
 * Methods it is safe to send twice.
 *
 * The distinction is the whole of the retry design. A transport failure means
 * no response came back — it does NOT mean the request never arrived. Hermes
 * may have created the block and lost the reply on the way home, so retrying a
 * POST risks two blocks where the merchant asked for one. A GET or a PUT
 * repeated has the same effect as sent once, so those are safe and a create is
 * not.
 */
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/** Waits between attempts. Short: a merchant is watching a spinner. */
const BACKOFF_MS = [250, 1_000];

/**
 * What Hermes said went wrong, from a 5xx body.
 *
 * Hermes answers a server error with `{"error":{"message":"Something went
 * wrong!","detail":"..."}}`, and the detail is the only part that says what
 * actually broke. Capped, because it can be a Java stack message.
 */
const serverErrorDetail = (body: string): string => {
  try {
    const error = (JSON.parse(body) as { error?: { detail?: unknown; message?: unknown } }).error;
    const detail = typeof error?.detail === "string" && error.detail !== "" ? error.detail : error?.message;
    if (typeof detail === "string" && detail !== "") return detail.slice(0, 300);
  } catch {
    // Not JSON: fall through to the generic wording.
  }
  return "Hermes reported an internal error";
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pure transport: one user's credentials, one base URL, no credential
 * lifecycle. Everything else cross-cutting (tracing, timing, failure mapping)
 * lives in the tool wrapper, so this stays trivially testable.
 *
 * It does retry, because the network under it is not reliable and a single
 * dropped connection should not fail a merchant's action. Measured against the
 * dev host: two attempts in five timed out while the other three answered in
 * under nine seconds. Retrying turns that into an action that works.
 */
export class HermesClient implements HermesRequester {
  constructor(
    private readonly baseUrl: string,
    private readonly user: UserContext,
    private readonly timeoutMs = 20_000
  ) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    // One extra attempt per backoff entry, and only when repeating the request
    // cannot change what it does.
    const attempts = IDEMPOTENT.has(method.toUpperCase()) ? BACKOFF_MS.length + 1 : 1;

    let lastFailure: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]!);

      try {
        return await this.attempt(method, path, options);
      } catch (err) {
        // Only a failure to get an answer is worth repeating. A 401, a 404 or a
        // rejected payload IS the answer, and asking again produces the same
        // one more slowly.
        if (!(err instanceof HermesUnavailableError)) throw err;
        lastFailure = err;
      }
    }

    throw lastFailure;
  }

  private async attempt(
    method: string,
    path: string,
    options: RequestOptions
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: method.toUpperCase(),
        headers: {
          ...headersFor(this.user),
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // The host, not just the path. "Hermes is unreachable calling
      // /api/v1/..." reads the same whether it is pointed at the real service
      // or at a local stub someone left configured, and those need opposite
      // fixes.
      throw new HermesUnavailableError(`${url.origin}${path}`, err);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) throw new HermesUnauthenticatedError(path);
    if (response.status === 403) throw new HermesForbiddenError(path);
    if (response.status === 404) throw new HermesNotFoundError(path);
    if (response.status >= 500) {
      throw new HermesUnavailableError(path, new Error(serverErrorDetail(await response.text())), response.status);
    }
    if (response.status >= 400) {
      throw new HermesRejectedError(path, response.status, await response.text());
    }
    if (response.status === 204) return null;

    const text = await response.text();
    if (!text) return null;
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === "object" && "data" in payload) {
      return (payload as { data: unknown }).data;
    }
    return payload;
  }
}
