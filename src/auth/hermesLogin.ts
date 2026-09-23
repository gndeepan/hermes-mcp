import { HermesRejectedError, HermesUnavailableError, errorMessage } from "../errors.js";

/** What one completed login yields. The shape the rest of the flow is written against. */
export interface LoginSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: string;
  stores: { id: string; name: string }[];
  isAdmin: boolean;
}

/**
 * The two calls a browser login makes, and the only place their wire format is
 * spelled out.
 *
 * Everything else in this feature — the loopback server, the pages, the store
 * picker, the credential file, the expiry handling — is written against this
 * interface and tested with a fake, so the wire format lives here alone. Both
 * steps mirror the dashboard's own login, which is the reference for them.
 */
/** One store in an admin's search results, as the picker shows it. */
export interface StoreMatch {
  storeId: string;
  name: string;
  appId: number | null;
  /**
   * False for a store Hermes knows but has no modern store id for. The
   * dashboard lists these greyed out ("Modernization not enabled for this
   * store"), and so does the picker: there is nothing the MCP could act on.
   */
  enabled: boolean;
}

export interface HermesLogin {
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<LoginSession>;
  /** Searches every store, for an admin choosing one. Uses the new session's own token. */
  searchStores(accessToken: string, query: string): Promise<StoreMatch[]>;
}

const SEND_PATH = "/api/v1/otp/email/send";
const SEARCH_PATH = "/api/v1/stores/search";

/** More than anyone reads in a picker; bounds the page, not the query. */
const MAX_MATCHES = 50;

/**
 * Where the verify step posts, exactly as the dashboard's own login does it
 * (`dashboard/packages/api/services/auth.ts`, `loginUser`).
 *
 * The code does not travel in the body. `POST /api/v1/auth/web` takes an empty
 * JSON body and reads the email and code from an HTTP Basic header,
 * `Basic base64(email:otp)`. The earlier guess — `/api/v1/otp/email/verify`
 * with the code in the body — is answered by Hermes with a bare 403, which is
 * what a merchant saw after typing a perfectly good code.
 */
const VERIFY_PATH = "/api/v1/auth/web";

/**
 * Raised when Hermes answers the verify step with something that is not a
 * merchant session.
 *
 * Kept distinct from a wrong code: a wrong code is the merchant's mistake and
 * is fixed by typing again, while this is a contract mismatch and is fixed by
 * an operator. Telling a merchant to "check the code" when the server is
 * calling the wrong endpoint would send them round a loop that cannot end.
 */
export class LoginContractError extends Error {
  constructor(detail: string) {
    super(
      `Hermes did not return a merchant session from ${VERIFY_PATH}: ${detail}. ` +
        "Compare src/auth/hermesLogin.ts against the dashboard's loginUser call."
    );
    this.name = "LoginContractError";
  }
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Reads the session out of whatever Hermes returned.
 *
 * Accepts both a bare object and one wrapped in `data`, because every Hermes
 * response seen so far uses the wrapper and the login endpoints are the one
 * place that has not been observed.
 */
const sessionFrom = (payload: unknown): LoginSession => {
  const root = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = (root.data !== null && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;

  const accessToken = asString(data.accessToken);
  const refreshToken = asString(data.refreshToken);
  if (accessToken === "" || refreshToken === "") {
    // Named explicitly: `customerAccessToken` is the storefront shopper
    // credential, and getting it here means the wrong endpoint was called
    // rather than that the merchant mistyped something.
    const wrong = asString(data.customerAccessToken) !== "" ? " (it returned a customerAccessToken, which is a storefront shopper credential)" : "";
    throw new LoginContractError(`the response carried no accessToken/refreshToken pair${wrong}`);
  }

  const rawStores = Array.isArray(data.stores) ? data.stores : [];
  const stores = rawStores.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const store = entry as Record<string, unknown>;
    const id = asString(store.id);
    return id === "" ? [] : [{ id, name: asString(store.name) || id }];
  });

  const expiresAt = typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) ? data.expiresAt : 0;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    userId: asString(data.userId),
    stores,
    isAdmin: data.isAdmin === true,
  };
};

/** One JSON POST, with Hermes' own error surfaced rather than a reconstructed one. */
const post = async (
  url: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new HermesUnavailableError(url, err);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const detail =
      (parsed as { error?: { detail?: string; message?: string } })?.error?.detail ??
      (parsed as { error?: { message?: string } })?.error?.message ??
      `HTTP ${response.status}`;
    throw new HermesRejectedError(url, response.status, detail);
  }
  return parsed;
};

/** One JSON GET, failing the same way `post` does. */
const get = async (url: string, timeoutMs: number, headers: Record<string, string>): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: { Accept: "application/json", ...headers }, signal: controller.signal });
  } catch (err) {
    throw new HermesUnavailableError(url, err);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail =
      (parsed as { error?: { detail?: string; message?: string } } | null)?.error?.detail ??
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      `HTTP ${response.status}`;
    throw new HermesRejectedError(url, response.status, detail);
  }
  return parsed;
};

export class HttpHermesLogin implements HermesLogin {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000
  ) {}

  async sendCode(email: string): Promise<void> {
    await post(new URL(SEND_PATH, this.baseUrl).toString(), { email }, this.timeoutMs);
  }

  async verifyCode(email: string, code: string): Promise<LoginSession> {
    // `Buffer`, not `btoa`: `btoa` throws on any character outside Latin-1,
    // and an email address may carry one.
    const basic = Buffer.from(`${email}:${code}`, "utf-8").toString("base64");
    const payload = await post(new URL(VERIFY_PATH, this.baseUrl).toString(), {}, this.timeoutMs, {
      Authorization: `Basic ${basic}`,
    });
    try {
      return sessionFrom(payload);
    } catch (err) {
      if (err instanceof LoginContractError) throw err;
      throw new LoginContractError(errorMessage(err));
    }
  }

  /**
   * The dashboard's store search, exactly as it sends it
   * (`dashboard/packages/api/services/store.ts`, `getStoreList`): the term as
   * both `dto` and `query`, and `type` APPID for an all-digit term, TAG for
   * anything else.
   *
   * Hermes returns each store's Shopify storefront token alongside it. That is
   * dropped here, the moment it arrives, so it cannot reach the browser.
   */
  async searchStores(accessToken: string, query: string): Promise<StoreMatch[]> {
    const term = query.trim().toLowerCase();
    const url = new URL(SEARCH_PATH, this.baseUrl);
    url.searchParams.set("dto", term);
    url.searchParams.set("query", term);
    url.searchParams.set("type", /^\d+$/.test(term) ? "APPID" : "TAG");

    const payload = await get(url.toString(), this.timeoutMs, { Authorization: `Bearer ${accessToken}` });
    const root = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const list = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : [];

    const matches = list.flatMap((entry): StoreMatch[] => {
      if (entry === null || typeof entry !== "object") return [];
      const store = entry as Record<string, unknown>;
      const storeId = asString(store.storeId);
      const name = asString(store.name);
      const appId = typeof store.appId === "number" && Number.isFinite(store.appId) ? store.appId : null;
      if (storeId === "" && name === "") return [];
      return [{ storeId, name: name || storeId, appId, enabled: storeId !== "" }];
    });

    // Usable stores first, as the dashboard sorts them.
    return matches.sort((a, b) => Number(b.enabled) - Number(a.enabled)).slice(0, MAX_MATCHES);
  }
}
