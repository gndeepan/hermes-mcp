import { spawn } from "node:child_process";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { SessionExpiredError, errorMessage, toToolResult } from "../errors.js";
import { EXPIRY_SKEW_MS, type TokenCache } from "../tokenRefresh.js";
import { startLoginServer, type PendingLogin } from "../auth/loginServer.js";
import type { CredentialStore, StoredSession } from "../auth/credentialStore.js";
import type { HermesLogin } from "../auth/hermesLogin.js";
import type { Logger } from "../logging.js";
import type { ToolReturn } from "./index.js";

/**
 * What `hermes_setup` needs to exist at all.
 *
 * Absent on the shared HTTP service and on a shared stdio process, and its
 * absence is what makes the tool disappear there. A multi-tenant process has no
 * business owning "the" signed-in session, and offering a login tool that
 * writes one would be offering the wrong thing convincingly.
 */
export interface AuthContext {
  store: CredentialStore;
  login: HermesLogin;
  logger: Logger;
  /** The one login in flight, if any. Mutable, and deliberately shared per process. */
  pending: { current?: PendingLogin };
  /**
   * Set once Hermes has refused the `.env` session's refresh token.
   *
   * `.env` normally wins over the stored session (see `fallbackCredentials`),
   * which is right while it works and a trap once it does not: a dead `.env`
   * token would shadow every browser sign-in, so signing in could never fix
   * it. Retiring it for the rest of the process lets the stored session, or a
   * new sign-in, take over. Mutable, like `pending`.
   */
  envRetired?: boolean;
  /** Injected by tests, so proving the flow does not open a real browser. */
  openBrowser?: (url: string) => Promise<boolean>;
}

export const SETUP_TOOL = "hermes_setup";

const DESCRIPTION =
  "Sign in to Hermes, or report who is already signed in. You rarely need to call this: any other hermes_* " +
  "tool called while nobody is signed in opens the sign-in itself, waits for it, and then answers — and if " +
  "the user is still signing in when it stops waiting, it returns SIGN_IN_REQUIRED, and calling that same " +
  "tool again is the whole remedy. Call this directly when the user asks to sign in or to see who is signed " +
  "in. If a valid session already exists this returns who it belongs to and how long it lasts, and opens " +
  "nothing; a session whose access token has lapsed is renewed silently. Otherwise it starts a small local web server on " +
  "127.0.0.1, opens the user's browser to it, and returns immediately with the URL — sign-in happens in " +
  "that browser tab, where the user enters their email, the one-time code they are emailed, and picks a " +
  "store. Do not wait or poll: tell the user to finish in the browser, then call this tool again to " +
  "confirm. The server shuts itself down as soon as sign-in completes.";

/**
 * Runs one opener, and answers whether it actually started.
 *
 * The asynchrony is not incidental. `spawn` does **not** throw when the binary
 * is missing: it returns a ChildProcess and emits `error` on a later tick, and
 * an unhandled `error` event on an EventEmitter takes the process down with it.
 * A `try/catch` around `spawn` catches none of that. So the answer comes from
 * racing the two events Node actually emits — `spawn` for success, `error` for
 * a missing or unrunnable binary — which is also the only way to know whether a
 * browser really opened before telling the user it did.
 *
 * Exported for the test that pins this, because the failure it prevents —
 * `hermes_setup` killing the server on a headless Linux box with no `xdg-open`
 * — cannot be reproduced on a platform where the opener always exists.
 */
export const openUrlWith = (command: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      // Some failures (an invalid command string) still land here.
      resolve(false);
      return;
    }
    // Both listeners attached before either can fire. `once` on `error` is what
    // keeps the event handled, and therefore non-fatal.
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      // Only after a successful start: unref'ing a process that never began has
      // nothing to detach from.
      child.unref();
      resolve(true);
    });
  });

/**
 * The openers to try, in order, for this platform.
 *
 * Linux gets a chain rather than one command. `xdg-open` is the convention but
 * is not present on a minimal image, and a desktop that lacks it often still
 * has one of the others. Windows and macOS each have exactly one that ships
 * with the OS, so there is nothing to fall back to.
 */
const openersFor = (url: string): [string, string[]][] => {
  if (process.platform === "win32") {
    // `start` is a cmd builtin, and the empty string is the window title —
    // without it, cmd treats a quoted URL as the title and opens nothing.
    return [["cmd", ["/c", "start", "", url]]];
  }
  if (process.platform === "darwin") return [["open", [url]]];
  return [
    ["xdg-open", [url]],
    ["sensible-browser", [url]],
    ["x-www-browser", [url]],
    ["www-browser", [url]],
  ];
};

/** Opens the platform's browser, and says whether it managed to. */
const openBrowser = async (url: string): Promise<boolean> => {
  for (const [command, args] of openersFor(url)) {
    if (await openUrlWith(command, args)) return true;
  }
  // Headless boxes, locked-down machines, SSH sessions. Not a failure — the URL
  // is in the reply and can be opened by hand.
  return false;
};

/** A browser sign-in, started by this call or joined from an earlier one. */
export interface LoginInProgress {
  url: string;
  /** Resolves with the saved session, or null if the window closed without one. */
  finished: Promise<StoredSession | null>;
  /** Whether a browser was opened by *this* call. False when joining. */
  opened: boolean;
  /** True when a sign-in was already open and this call joined it. */
  joined: boolean;
}

/**
 * Starts a browser sign-in, or joins the one already open.
 *
 * The one place a login server is started, shared by `hermes_setup` and by a
 * tool call that found nobody signed in. Two callers starting two servers
 * would leave two live logins racing to write the same file.
 */
export const beginLogin = async (auth: AuthContext): Promise<LoginInProgress> => {
  const inFlight = auth.pending.current;
  if (inFlight !== undefined) {
    return { url: inFlight.url, finished: inFlight.finished, opened: false, joined: true };
  }

  const pending = await startLoginServer({ login: auth.login, store: auth.store, logger: auth.logger });
  auth.pending.current = pending;
  void pending.finished.finally(() => {
    // Only this login's own slot: a later one may already have taken it.
    if (auth.pending.current === pending) auth.pending.current = undefined;
  });

  const opened = await (auth.openBrowser ?? openBrowser)(pending.url);
  auth.logger.info("login started", { opened });
  return { url: pending.url, finished: pending.finished, opened, joined: false };
};

const humanDuration = (ms: number): string => {
  if (ms <= 0) return "0m";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const text = (body: string): ToolReturn => ({ content: [{ type: "text", text: body }] });

/**
 * Renews a stored session whose access token has lapsed, and saves the result.
 *
 * An expired access token is not an expired session: the refresh token usually
 * outlives it by days. Sending the merchant to the browser for what one POST
 * would fix is exactly the friction the refresh token exists to remove.
 *
 * Null means the refresh token is dead too, and only a sign-in will do. A
 * Hermes outage is thrown instead — it says nothing about the session, and
 * treating it as "signed out" would discard one that is fine.
 */
const renewStored = async (
  auth: AuthContext,
  tokens: TokenCache,
  existing: StoredSession
): Promise<StoredSession | null> => {
  try {
    const renewed = await tokens.accessTokenFor(existing.refreshToken, { force: true });
    const session = { ...existing, ...renewed };
    auth.store.save(session);
    auth.logger.info("renewed stored hermes session", { storeId: existing.storeId });
    return session;
  } catch (err) {
    if (!(err instanceof SessionExpiredError)) throw err;
    auth.store.clear();
    return null;
  }
};

export const registerSetupTool = (
  server: McpServer,
  auth: AuthContext,
  tokens?: TokenCache
): void => {
  server.registerTool(
    SETUP_TOOL,
    { description: DESCRIPTION, inputSchema: z.object({}) },
    (async (): Promise<ToolReturn> => {
      try {
        let existing = auth.store.read();
        // Usable means "will still be usable by the time a call lands", which is
        // why the skew is subtracted. A session with thirty seconds left is a
        // session that is about to fail mid-conversation.
        if (existing !== null && Date.now() >= existing.expiresAt - EXPIRY_SKEW_MS && tokens !== undefined) {
          existing = (await renewStored(auth, tokens, existing)) ?? existing;
        }
        if (existing !== null && Date.now() < existing.expiresAt - EXPIRY_SKEW_MS) {
          return text(
            `Signed in as ${existing.userId} on ${existing.storeName} (${existing.storeId}).\n` +
              `Access token valid for another ${humanDuration(existing.expiresAt - Date.now())}.`
          );
        }

        const { url, opened, joined } = await beginLogin(auth);

        // A second call while a browser tab is already open hands back the same
        // URL rather than racing a second server.
        if (joined) {
          return text(
            `A sign-in is already waiting in your browser:\n${url}\n\n` +
              "Finish there, then call this tool again to confirm."
          );
        }

        return text(
          (existing === null
            ? "No Hermes session found."
            : "Your Hermes session has expired.") +
            (opened
              ? `\nOpened your browser to:\n${url}`
              : `\nCould not open a browser automatically. Open this URL yourself:\n${url}`) +
            "\n\nSign in there with your email and the code we email you, then call this tool again to confirm. " +
            "The link is good for 5 minutes."
        );
      } catch (err) {
        auth.logger.error("setup failed", { error: errorMessage(err) });
        return toToolResult(err, auth.logger, SETUP_TOOL);
      }
    }) as Parameters<typeof server.registerTool>[2]
  );
};
