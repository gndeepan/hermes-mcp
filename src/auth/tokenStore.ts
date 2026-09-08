import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import envPaths from "env-paths";

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Always normalized by `write`. */
  expiresAt: number;
  storeId: string;
}

/**
 * Hermes declares `expiresAt` only as `integer` with no unit, so it could be
 * epoch seconds or epoch milliseconds. Anything below this bound (roughly the
 * year 2286 in seconds, far above any plausible epoch-ms value's lower bound)
 * is treated as seconds and scaled up, so every consumer works in one unit.
 */
const SECONDS_EPOCH_THRESHOLD = 10_000_000_000;

export const normalizeExpiresAt = (value: number): number =>
  value < SECONDS_EPOCH_THRESHOLD ? value * 1000 : value;

export interface TokenStore {
  read(): StoredCredentials | null;
  write(credentials: StoredCredentials): void;
}

export const createTokenStore = (
  configDir: string = envPaths("hermes-mcp").config
): TokenStore => {
  const file = path.join(configDir, "credentials.json");
  return {
    read(): StoredCredentials | null {
      if (!existsSync(file)) return null;
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<StoredCredentials>;
        if (
          typeof raw.accessToken !== "string" ||
          typeof raw.refreshToken !== "string" ||
          typeof raw.expiresAt !== "number" ||
          typeof raw.storeId !== "string"
        ) {
          return null;
        }
        return raw as StoredCredentials;
      } catch {
        return null;
      }
    },
    write(credentials: StoredCredentials): void {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ ...credentials, expiresAt: normalizeExpiresAt(credentials.expiresAt) }, null, 2),
        "utf-8"
      );
    },
  };
};
