import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../../src/auth/tokenManager.js";
import type { StoredCredentials, TokenStore } from "../../src/auth/tokenStore.js";
import { HermesAuthError, HermesUnavailableError, MissingCredentialsError } from "../../src/errors.js";

const fakeStore = (
  initial: StoredCredentials | null = null
): TokenStore & { written: StoredCredentials[] } => {
  let current = initial;
  const written: StoredCredentials[] = [];
  return {
    read: () => current,
    write: (c) => {
      current = c;
      written.push(c);
    },
    written,
  };
};

const at = (ms: number): (() => number) => () => ms;

describe("TokenManager", () => {
  it("throws MissingCredentialsError when nothing is loaded", async () => {
    const manager = new TokenManager({ store: fakeStore(), baseUrl: "https://hermes.test" }, null);
    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
  });

  it("reads credentials from the store when none are passed in", async () => {
    const stored: StoredCredentials = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_000_000 + 600_000,
      storeId: "s1",
    };
    const manager = new TokenManager({
      store: fakeStore(stored),
      baseUrl: "https://hermes.test",
      now: at(1_000_000),
    });
    expect(await manager.getValidCredentials()).toEqual({ accessToken: "a", storeId: "s1" });
  });

  it("returns the current credentials unchanged when far from expiry", async () => {
    const refresh = vi.fn();
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r", expiresAt: 1_000_000 + 120_000, storeId: "s1" }
    );

    expect(await manager.getValidCredentials()).toEqual({ accessToken: "a", storeId: "s1" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes and persists when within 60s of expiry, keeping the same storeId", async () => {
    const store = fakeStore();
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2_000_000_000_000,
    }));
    const manager = new TokenManager(
      { store, baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 30_000, storeId: "s1" }
    );

    const creds = await manager.getValidCredentials();

    expect(refresh).toHaveBeenCalledWith("https://hermes.test", "r1");
    expect(creds).toEqual({ accessToken: "a2", storeId: "s1" });
    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toEqual({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2_000_000_000_000,
      storeId: "s1",
    });
  });

  it("normalizes a seconds-epoch expiresAt returned by the refresh call", async () => {
    const store = fakeStore();
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 1_800_000_000,
    }));
    const manager = new TokenManager(
      { store, baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000, storeId: "s1" }
    );

    await manager.getValidCredentials();

    expect(store.written[0].expiresAt).toBe(1_800_000_000_000);
  });

  it("forceRefresh refreshes even when the token is nowhere near expiry", async () => {
    const refresh = vi.fn(async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 2_000_000_000_000,
    }));
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 999_000, storeId: "s1" }
    );

    expect((await manager.forceRefresh()).accessToken).toBe("a2");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("throws MissingCredentialsError and stops retrying once the refresh is rejected with a 401", async () => {
    const refresh = vi.fn(async () => {
      throw new HermesAuthError("/api/v1/auth/refresh", 401);
    });
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "expired", expiresAt: 1_000_000 + 10_000, storeId: "s1" }
    );

    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the credentials usable after a transport failure, so a later call still succeeds", async () => {
    const store = fakeStore();
    let attempt = 0;
    const refresh = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return { accessToken: "a2", refreshToken: "r2", expiresAt: 2_000_000_000_000 };
    });
    const manager = new TokenManager(
      { store, baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 10_000, storeId: "s1" }
    );

    await expect(manager.getValidCredentials()).rejects.toThrow(HermesUnavailableError);
    expect(await manager.getValidCredentials()).toEqual({ accessToken: "a2", storeId: "s1" });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith("https://hermes.test", "r1");
  });

  it("keeps the credentials after a 5xx refresh failure and reports unavailability", async () => {
    const refresh = vi.fn(async () => {
      throw new HermesAuthError("/api/v1/auth/refresh", 502);
    });
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 10_000, storeId: "s1" }
    );

    await expect(manager.getValidCredentials()).rejects.toThrow(HermesUnavailableError);
    await expect(manager.getValidCredentials()).rejects.toThrow(HermesUnavailableError);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("clears the credentials when the refresh is rejected with a 403", async () => {
    const refresh = vi.fn(async () => {
      throw new HermesAuthError("/api/v1/auth/refresh", 403);
    });
    const manager = new TokenManager(
      { store: fakeStore(), baseUrl: "https://hermes.test", now: at(1_000_000), refresh },
      { accessToken: "a", refreshToken: "r1", expiresAt: 1_000_000 + 10_000, storeId: "s1" }
    );

    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
    await expect(manager.getValidCredentials()).rejects.toThrow(MissingCredentialsError);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
