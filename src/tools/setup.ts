import { spawn } from "node:child_process";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorMessage, toToolResult } from "../errors.js";
import { EXPIRY_SKEW_MS } from "../tokenRefresh.js";
import { startLoginServer, type PendingLogin } from "../auth/loginServer.js";
import type { CredentialStore } from "../auth/credentialStore.js";
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
}

export const SETUP_TOOL = "hermes_setup";

const DESCRIPTION =
  "Sign in to Hermes, or report who is already signed in. Call this first when any other hermes_* tool " +
  "reports MISSING_CREDENTIALS or SESSION_EXPIRED. If a valid session already exists this returns who it " +
  "belongs to and how long it lasts, and opens nothing. Otherwise it starts a small local web server on " +
  "127.0.0.1, opens the user's browser to it, and returns immediately with the URL — sign-in happens in " +
  "that browser tab, where the user enters their email, the one-time code they are emailed, and picks a " +
  "store. Do not wait or poll: tell the user to finish in the browser, then call this tool again to " +
  "confirm. The server shuts itself down as soon as sign-in completes.";

/** Opens the platform's browser, and says whether it managed to. */
const openBrowser = (url: string): boolean => {
  const [command, args] =
    process.platform === "win32"
      ? // `start` is a cmd builtin, and the empty string is the window title —
        // without it, cmd treats a quoted URL as the title and opens nothing.
        (["cmd", ["/c", "start", "", url]] as const)
      : process.platform === "darwin"
        ? (["open", [url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    // Headless boxes, locked-down machines, SSH sessions. Not a failure — the
    // URL is in the reply and can be opened by hand.
    return false;
  }
};

const humanDuration = (ms: number): string => {
  if (ms <= 0) return "0m";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
};

const text = (body: string): ToolReturn => ({ content: [{ type: "text", text: body }] });

export const registerSetupTool = (server: McpServer, auth: AuthContext): void => {
  server.registerTool(
    SETUP_TOOL,
    { description: DESCRIPTION, inputSchema: z.object({}) },
    (async (): Promise<ToolReturn> => {
      try {
        const existing = auth.store.read();
        // Usable means "will still be usable by the time a call lands", which is
        // why the skew is subtracted. A session with thirty seconds left is a
        // session that is about to fail mid-conversation.
        if (existing !== null && Date.now() < existing.expiresAt - EXPIRY_SKEW_MS) {
          return text(
            `Signed in as ${existing.userId} on ${existing.storeName} (${existing.storeId}).\n` +
              `Access token valid for another ${humanDuration(existing.expiresAt - Date.now())}.`
          );
        }

        // A second call while a browser tab is already open hands back the same
        // URL. Starting a rival server would leave two live logins racing to
        // write the same file.
        const inFlight = auth.pending.current;
        if (inFlight !== undefined) {
          return text(
            `A sign-in is already waiting in your browser:\n${inFlight.url}\n\n` +
              "Finish there, then call this tool again to confirm."
          );
        }

        const pending = await startLoginServer({
          login: auth.login,
          store: auth.store,
          logger: auth.logger,
        });
        auth.pending.current = pending;
        void pending.finished.finally(() => {
          auth.pending.current = undefined;
        });

        const opened = openBrowser(pending.url);
        auth.logger.info("login started", { opened });

        return text(
          (existing === null
            ? "No Hermes session found."
            : "Your Hermes session has expired.") +
            (opened
              ? `\nOpened your browser to:\n${pending.url}`
              : `\nCould not open a browser automatically. Open this URL yourself:\n${pending.url}`) +
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
