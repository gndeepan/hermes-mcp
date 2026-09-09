import { HermesAuthError } from "../errors.js";

/**
 * Matches `HermesClient`'s own transport timeout. Without one, a hung
 * `/auth/refresh` hangs a tool call through the whole MCP chain, and a hung
 * `/auth/web` hangs `npm run login` with no output at all.
 */
const AUTH_TIMEOUT_MS = 20_000;

export interface LoginStore {
  id: string;
  name: string;
  /** Absent on search results — Hermes's StoreSearchResponse carries no domain. */
  domain?: string;
  appId?: number;
}

export interface WebLoginResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  isAdmin: boolean;
  /**
   * The stores this account is directly assigned. Hermes omits the field
   * entirely for some accounts and returns it empty for internal admins, who
   * reach a store through `searchStores` instead — so this is normalized to an
   * array and an empty one is a normal state, not a failure.
   */
  stores: LoginStore[];
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Hermes wraps some successful bodies in `{ "data": ... }` and some not. */
const unwrap = <T>(payload: unknown): T =>
  (payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: unknown }).data
    : payload) as T;

const send = async (url: URL, init: RequestInit, headers: Record<string, string>): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    // Names only the path and status: the Authorization header carries the OTP.
    throw new HermesAuthError(url.pathname, response.status);
  }
  return response.json();
};

const postJson = (url: URL, body: unknown, headers: Record<string, string> = {}): Promise<unknown> =>
  send(url, { method: "POST", body: JSON.stringify(body) }, { "Content-Type": "application/json", ...headers });

const getJson = (url: URL, headers: Record<string, string> = {}): Promise<unknown> =>
  send(url, { method: "GET" }, headers);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const toLoginStore = (raw: unknown): LoginStore => {
  const record = (raw ?? {}) as Record<string, unknown>;
  // `/auth/web` names it `id`, `/stores/search` names it `storeId`.
  const id = asString(record.id) || asString(record.storeId);
  const appId = typeof record.appId === "number" ? record.appId : undefined;
  return {
    id,
    name: asString(record.name) || id || "(unnamed store)",
    domain: typeof record.domain === "string" ? record.domain : undefined,
    appId,
  };
};

const toLoginStores = (raw: unknown): LoginStore[] =>
  Array.isArray(raw) ? raw.map(toLoginStore) : [];

/** Mails a one-time code. Sends no Authorization header — this call precedes having a token. */
export const sendEmailOtp = async (baseUrl: string, email: string): Promise<void> => {
  await postJson(new URL("/api/v1/otp/email/send", baseUrl), { email });
};

/**
 * Exchanges an emailed one-time code for a token pair.
 * The Basic-auth password slot carries the OTP, not a password, and the body is
 * empty — this mirrors the Dashboard's own call exactly.
 */
export const webLogin = async (baseUrl: string, email: string, otp: string): Promise<WebLoginResult> => {
  const basic = Buffer.from(`${email}:${otp}`, "utf-8").toString("base64");
  const payload = await postJson(new URL("/api/v1/auth/web", baseUrl), {}, {
    Authorization: `Basic ${basic}`,
  });
  const body = unwrap<Record<string, unknown>>(payload);
  return {
    userId: asString(body.userId),
    accessToken: asString(body.accessToken),
    refreshToken: asString(body.refreshToken),
    expiresAt: Number(body.expiresAt),
    isAdmin: Boolean(body.isAdmin),
    stores: toLoginStores(body.stores),
  };
};

/**
 * Finds stores by name/tag or numeric app id, the way the Dashboard's own store
 * switcher does. This is how an internal admin — whose `/auth/web` store list is
 * empty because they can reach every store — gets a store id to log in with.
 *
 * Results whose `storeId` is empty are stores that exist but have no
 * modernization store id, so nothing here can act on them; they are returned
 * with `id: ""` so the picker can show them as unavailable rather than silently
 * omitting a store the operator just searched for by name.
 */
export const searchStores = async (
  baseUrl: string,
  accessToken: string,
  query: string
): Promise<LoginStore[]> => {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const url = new URL("/api/v1/stores/search", baseUrl);
  // Hermes flattens its SearchDto across `dto`/`query`/`type`, and reads a purely
  // numeric query as an app id — same three params the Dashboard sends.
  url.searchParams.set("dto", trimmed);
  url.searchParams.set("query", trimmed);
  url.searchParams.set("type", Number(trimmed) ? "APPID" : "TAG");
  const payload = await getJson(url, { Authorization: `Bearer ${accessToken}` });
  return toLoginStores(unwrap<unknown>(payload));
};

/** Registers the chosen store server-side. The response body is not inspected — only success matters. */
export const storeLogin = async (baseUrl: string, accessToken: string, storeId: string): Promise<void> => {
  await postJson(new URL("/api/v1/auth/stores/login", baseUrl), {}, {
    Authorization: `Bearer ${accessToken}`,
    "X-Store-Id": storeId,
  });
};

export const refreshAccessToken = async (baseUrl: string, refreshToken: string): Promise<RefreshResult> => {
  const payload = await postJson(new URL("/api/v1/auth/refresh", baseUrl), { refreshToken });
  return unwrap<RefreshResult>(payload);
};
