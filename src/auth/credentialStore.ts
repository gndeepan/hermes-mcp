import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One merchant's signed-in session, as it survives a restart.
 *
 * This is the file that makes hard constraint #2 — "never persist a credential"
 * — no longer true everywhere. It is still true everywhere else: the shared
 * HTTP service never constructs this class, and a shared stdio process never
 * reads it. Persisting here is the whole point of a single-user CLI, where
 * "stay signed in" is the feature being asked for.
 *
 * `storeName` is carried only so `hermes_setup` can say "on SuperHero-vjro"
 * instead of "on str_0hpxwcdnd2m19". It is a label, never an input to a call.
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: string;
  storeId: string;
  storeName: string;
}

/**
 * Narrows a file to its owner, by whatever means the platform actually honours.
 *
 * POSIX mode bits are a no-op on Windows: `chmodSync(path, 0o600)` there toggles
 * the read-only attribute and nothing else, and `statSync` still reports group
 * and world read bits. Asserting 0o600 on Windows would be asserting a fiction,
 * and — worse — shipping one: the refresh token would sit in a file every other
 * account on the machine can read.
 *
 * So Windows gets an ACL instead. `/inheritance:r` drops the inherited entries
 * (which is what grants BUILTIN\Users access in the first place) and `/grant:r`
 * re-grants full control to the current user alone.
 *
 * Best-effort by design: a machine where this fails still has a working login.
 * The file is already written by the time this runs, so the alternative would be
 * to delete a valid session over a hardening step, which trades a small risk for
 * a certain failure.
 */
const restrictToOwner = (path: string): void => {
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Left as the OS made it. See the note above on why this is not fatal.
  }
};

const DIRECTORY = ".hermes-mcp";
const FILE = "credentials.json";

/** Every field that must be present and usable for the file to mean "signed in". */
const isSession = (value: unknown): value is StoredSession => {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    v.accessToken !== "" &&
    typeof v.refreshToken === "string" &&
    v.refreshToken !== "" &&
    typeof v.expiresAt === "number" &&
    Number.isFinite(v.expiresAt) &&
    typeof v.userId === "string" &&
    typeof v.storeId === "string" &&
    v.storeId !== ""
  );
};

/**
 * The signed-in session on disk.
 *
 * `home` is injected rather than read from the environment at each call so a
 * test can point the whole store at a temp directory without touching the
 * developer's real one — and so that a wrong `HOME` can never silently write a
 * merchant's refresh token somewhere unexpected.
 */
export class CredentialStore {
  readonly path: string;
  readonly #directory: string;

  constructor(home: string = homedir()) {
    this.#directory = join(home, DIRECTORY);
    this.path = join(this.#directory, FILE);
  }

  /**
   * The stored session, or `null` for anything that is not one.
   *
   * A missing file, an unreadable file, malformed JSON and a half-written
   * object all answer the same way, because the remedy is the same for all of
   * them: sign in again. Throwing here would turn a recoverable state into a
   * server that refuses to start.
   */
  read(): StoredSession | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      return isSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Writes the session, returning whether it will actually survive a restart.
   *
   * A failed write is reported rather than thrown: the login it came from
   * succeeded, the process holds a working session, and the only thing lost is
   * persistence. The caller says so in its reply instead of failing a login
   * that worked.
   */
  save(session: StoredSession): boolean {
    try {
      // 0o700 on the directory for the same reason as 0o600 on the file: on a
      // shared machine the listing itself should not be readable.
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      writeFileSync(this.path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
      // writeFileSync only applies `mode` when it creates the file, so an
      // existing file keeps whatever permissions it already had. Setting it
      // again is what makes the guarantee hold on the second save.
      restrictToOwner(this.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets the session. Used when Hermes says the refresh token is dead. */
  clear(): void {
    try {
      if (existsSync(this.path)) rmSync(this.path);
    } catch {
      // Nothing useful to do: the session is already unusable, and failing to
      // delete it must not stop the caller from asking for a new one.
    }
  }
}
