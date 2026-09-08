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
    // Deliberately does not include the request body — it carries the password.
    throw new Error(`Hermes ${url.pathname} failed with status ${response.status}`);
  }
  return response.json();
};

export const webLogin = async (
  baseUrl: string,
  domain: string,
  email: string,
  password: string
): Promise<WebLoginResult> => {
  const basic = Buffer.from(`${email}:${password}`, "utf-8").toString("base64");
  const payload = await postJson(new URL("/api/v1/auth/web", baseUrl), { domain }, {
    Authorization: `Basic ${basic}`,
  });
  return unwrap<WebLoginResult>(payload);
};

export const refreshAccessToken = async (baseUrl: string, refreshToken: string): Promise<RefreshResult> => {
  const payload = await postJson(new URL("/api/v1/auth/refresh", baseUrl), { refreshToken });
  return unwrap<RefreshResult>(payload);
};
