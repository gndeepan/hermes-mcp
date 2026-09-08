import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
} from "./errors.js";

export interface Credentials {
  accessToken: string;
  storeId: string;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
}

export interface HermesRequester {
  request(method: string, path: string, options?: RequestOptions): Promise<unknown>;
}

export class HermesClient implements HermesRequester {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: Credentials,
    private readonly timeoutMs = 20_000
  ) {}

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
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
          Authorization: `Bearer ${this.credentials.accessToken}`,
          "X-Store-Id": this.credentials.storeId,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new HermesUnavailableError(path, err);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) throw new HermesUnauthenticatedError(path);
    if (response.status === 403) throw new HermesForbiddenError(path);
    if (response.status === 404) throw new HermesNotFoundError(path);
    if (response.status >= 500) {
      throw new HermesUnavailableError(path, new Error(`Hermes returned ${response.status}`));
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
