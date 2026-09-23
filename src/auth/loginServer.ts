import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../logging.js";
import { errorMessage } from "../errors.js";
import type { CredentialStore, StoredSession } from "./credentialStore.js";
import type { HermesLogin, LoginSession } from "./hermesLogin.js";
import { codePage, donePage, emailPage, noStoresPage, storePage } from "./pages.js";

/** How long a login may stay open before the server closes itself. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface LoginServerOptions {
  login: HermesLogin;
  store: CredentialStore;
  logger: Logger;
  /** Overridable so a test does not wait five minutes to prove the deadline works. */
  timeoutMs?: number;
}

export interface PendingLogin {
  /** The one URL to open. Carries the nonce; nothing else does. */
  url: string;
  /** Resolves when the login finishes, fails, or the deadline passes. */
  finished: Promise<StoredSession | null>;
  close(): void;
}

/** Where the merchant is in the flow. Held in the process, never in a cookie or a URL. */
interface FlowState {
  email?: string;
  session?: LoginSession;
}

const html = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};

const redirect = (res: ServerResponse, to: string): void => {
  // 303 specifically: it turns the POST into a GET, so a refresh on the next
  // screen does not resubmit the code.
  res.writeHead(303, { Location: to, "Cache-Control": "no-store" });
  res.end();
};

const readBody = async (req: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A login form is a few hundred bytes. Anything larger is not this form,
    // and reading it would just be someone else's payload in our memory.
    if (size > 16_384) break;
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
};

/**
 * Serves the login flow on the loopback interface until it is finished with.
 *
 * Three rules make this safe enough to open on a developer's machine:
 *
 * - it binds `127.0.0.1`, so nothing off the machine can reach it;
 * - every request must carry the nonce from the opening URL, so no other local
 *   process can drive the flow even though the port is open;
 * - it closes on success and, regardless, when the deadline passes. A login
 *   server that outlives its login is an open door nobody is watching.
 *
 * Tokens never reach the browser. The pages collect an email and a code; this
 * process calls Hermes and keeps the result. Nothing sensitive is ever put in a
 * URL, a redirect target or a page body, so nothing can leak through history, a
 * referer header or a screenshot.
 */
export const startLoginServer = async (options: LoginServerOptions): Promise<PendingLogin> => {
  const { login, store, logger } = options;
  const nonce = randomBytes(24).toString("base64url");
  const state: FlowState = {};

  let settle: (value: StoredSession | null) => void;
  const finished = new Promise<StoredSession | null>((resolve) => {
    settle = resolve;
  });

  let closed = false;
  let deadline: NodeJS.Timeout;
  const close = (result: StoredSession | null = null): void => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    server.close();
    settle(result);
  };

  /** Everything the store screen needs, and the decision of whether to show it. */
  const finish = (session: LoginSession, storeId: string, storeName: string, res: ServerResponse): void => {
    const persisted = store.save({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      userId: session.userId,
      storeId,
      storeName,
    });
    logger.info("login complete", { userId: session.userId, storeId, persisted });
    html(res, 200, donePage(storeName, persisted));
    // Closed after the response, not before, or the browser gets a dead socket
    // instead of the page that tells the merchant they are done.
    setTimeout(() => close(store.read()), 250);
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "POST" ? await readBody(req) : new URLSearchParams();
      const presented = url.searchParams.get("k") ?? body.get("k") ?? "";

      // No body, no hint about whether a login is even in progress.
      if (presented !== nonce) {
        res.writeHead(403).end();
        return;
      }

      // GET /            the email screen
      if (req.method === "GET" && url.pathname === "/") {
        html(res, 200, emailPage(nonce));
        return;
      }

      // POST /email      send the code
      if (req.method === "POST" && url.pathname === "/email") {
        const email = (body.get("email") ?? "").trim();
        if (email === "") {
          html(res, 400, emailPage(nonce, "Enter your email address."));
          return;
        }
        try {
          await login.sendCode(email);
          state.email = email;
          redirect(res, `/otp?k=${nonce}`);
        } catch (err) {
          // Hermes' own words. A reconstructed message here would be a guess
          // about someone else's validation rules.
          html(res, 502, emailPage(nonce, errorMessage(err)));
        }
        return;
      }

      // GET /otp         the code screen
      if (req.method === "GET" && url.pathname === "/otp") {
        if (state.email === undefined) {
          redirect(res, `/?k=${nonce}`);
          return;
        }
        html(res, 200, codePage(nonce, state.email));
        return;
      }

      // POST /otp        verify, and decide where the merchant goes next
      if (req.method === "POST" && url.pathname === "/otp") {
        const email = state.email;
        if (email === undefined) {
          redirect(res, `/?k=${nonce}`);
          return;
        }
        const code = (body.get("code") ?? "").trim();
        if (code === "") {
          html(res, 400, codePage(nonce, email, "Enter the code from your email."));
          return;
        }

        let session: LoginSession;
        try {
          session = await login.verifyCode(email, code);
        } catch (err) {
          html(res, 400, codePage(nonce, email, errorMessage(err)));
          return;
        }
        state.session = session;

        // One store selects itself; there is nothing to ask.
        if (session.stores.length === 1) {
          const only = session.stores[0]!;
          finish(session, only.id, only.name, res);
          return;
        }
        // No stores and not an admin: nothing to pick, and an empty list would
        // read as a broken tool rather than as a fact about the account.
        if (session.stores.length === 0 && !session.isAdmin) {
          logger.warn("login has no stores", { userId: session.userId });
          html(res, 200, noStoresPage());
          setTimeout(() => close(null), 250);
          return;
        }
        redirect(res, `/store?k=${nonce}`);
        return;
      }

      // GET /store       the picker, or the field an admin needs
      if (req.method === "GET" && url.pathname === "/store") {
        if (state.session === undefined) {
          redirect(res, `/?k=${nonce}`);
          return;
        }
        html(res, 200, storePage(nonce, state.session.stores));
        return;
      }

      // POST /store      the choice
      if (req.method === "POST" && url.pathname === "/store") {
        const session = state.session;
        if (session === undefined) {
          redirect(res, `/?k=${nonce}`);
          return;
        }
        const storeId = (body.get("storeId") ?? "").trim();
        if (storeId === "") {
          html(res, 400, storePage(nonce, session.stores, "Choose a store."));
          return;
        }
        const named = session.stores.find((s) => s.id === storeId);
        finish(session, storeId, named?.name ?? storeId, res);
        return;
      }

      res.writeHead(404).end();
    })().catch((err: unknown) => {
      logger.error("login server request failed", { error: errorMessage(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  deadline = setTimeout(() => {
    logger.info("login window expired without a sign-in");
    close(null);
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  deadline.unref();

  return {
    url: `http://127.0.0.1:${port}/?k=${nonce}`,
    finished,
    close: () => close(null),
  };
};
