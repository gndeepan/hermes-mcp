export interface LoginStore {
  id: string;
  name: string;
  domain: string;
}

export interface WebLoginResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  isAdmin: boolean;
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

const postJson = async (url: URL, body: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Names only the path and status: the Authorization header carries the OTP.
    throw new Error(`Hermes ${url.pathname} failed with status ${response.status}`);
  }
  return response.json();
};

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
  return unwrap<WebLoginResult>(payload);
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
