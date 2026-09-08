import { MissingCredentialsError } from "../errors.js";
import type { Credentials } from "../hermesClient.js";
import { refreshAccessToken } from "./hermesAuth.js";
import { normalizeExpiresAt, type StoredCredentials, type TokenStore } from "./tokenStore.js";

/** Refresh this far ahead of the recorded expiry, to absorb clock skew and latency. */
const EXPIRY_SKEW_MS = 60_000;

export interface TokenManagerDeps {
  store: TokenStore;
  baseUrl: string;
  now?: () => number;
  refresh?: typeof refreshAccessToken;
}

export class TokenManager {
  private current: StoredCredentials | null;
  private readonly store: TokenStore;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly refresh: typeof refreshAccessToken;

  constructor(deps: TokenManagerDeps, initial?: StoredCredentials | null) {
    this.store = deps.store;
    this.baseUrl = deps.baseUrl;
    this.now = deps.now ?? Date.now;
    this.refresh = deps.refresh ?? refreshAccessToken;
    this.current = initial === undefined ? deps.store.read() : initial;
  }

  async getValidCredentials(): Promise<Credentials> {
    if (!this.current) throw new MissingCredentialsError();
    if (this.current.expiresAt - this.now() > EXPIRY_SKEW_MS) {
      return { accessToken: this.current.accessToken, storeId: this.current.storeId };
    }
    return this.refreshNow();
  }

  /** Refreshes regardless of the recorded expiry — the 401-retry-once path. */
  async forceRefresh(): Promise<Credentials> {
    if (!this.current) throw new MissingCredentialsError();
    return this.refreshNow();
  }

  private async refreshNow(): Promise<Credentials> {
    const previous = this.current;
    if (!previous) throw new MissingCredentialsError();

    let refreshed: { accessToken: string; refreshToken: string; expiresAt: number };
    try {
      refreshed = await this.refresh(this.baseUrl, previous.refreshToken);
    } catch {
      // A refresh token Hermes will not honour means no token will work until a
      // fresh login. Drop it so later calls fail fast instead of re-hammering
      // the refresh endpoint on every tool call.
      this.current = null;
      throw new MissingCredentialsError();
    }

    const next: StoredCredentials = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: normalizeExpiresAt(refreshed.expiresAt),
      storeId: previous.storeId,
    };
    this.current = next;
    this.store.write(next);
    return { accessToken: next.accessToken, storeId: next.storeId };
  }
}
