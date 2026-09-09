import http from "node:http";
import type { AddressInfo } from "node:net";
import { searchStores, sendEmailOtp, storeLogin, webLogin } from "../auth/hermesAuth.js";
import type { LoginStore } from "../auth/hermesAuth.js";
import type { TokenStore } from "../auth/tokenStore.js";
import {
  renderDone,
  renderEmailForm,
  renderMessage,
  renderOtpForm,
  renderStorePicker,
} from "./loginPage.js";

export interface LoginServerDeps {
  hermesBaseUrl: string;
  store: TokenStore;
  sendOtp?: typeof sendEmailOtp;
  login?: typeof webLogin;
  selectStore?: typeof storeLogin;
  findStores?: typeof searchStores;
  presetStoreId?: string;
}

export interface LoginServer {
  /**
   * The resolved bind address. Exposed so a test can assert the one security
   * property of a throwaway HTTP server that briefly accepts a one-time code:
   * it is reachable from this machine only.
   */
  address: string;
  port: number;
  close(): Promise<void>;
  /** Resolves true once credentials are persisted, false if closed without a login. */
  waitForCompletion(): Promise<boolean>;
}

const readBody = async (req: http.IncomingMessage): Promise<Record<string, string>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }
  return Object.fromEntries(new URLSearchParams(raw));
};

const html = (res: http.ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};

/** Loopback only: this server briefly accepts a one-time code. */
const LOOPBACK = "127.0.0.1";

/**
 * Only an id Hermes itself handed us may be persisted — a store with no
 * modernization id comes back as `id: ""` and must never satisfy this.
 */
const isKnownStore = (stores: LoginStore[], id: string): boolean =>
  id !== "" && stores.some((store) => store.id === id);

interface PendingLogin {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  isAdmin: boolean;
  /** Every store Hermes has named for this session: the login list plus any search hit. */
  knownStores: LoginStore[];
}

export const startLoginServer = (deps: LoginServerDeps): Promise<LoginServer> => {
  const sendOtp = deps.sendOtp ?? sendEmailOtp;
  const login = deps.login ?? webLogin;
  const selectStore = deps.selectStore ?? storeLogin;
  const findStores = deps.findStores ?? searchStores;
  let pending: PendingLogin | null = null;
  let settle: (ok: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const rememberStores = (session: PendingLogin, stores: LoginStore[]): void => {
    for (const store of stores) {
      if (store.id && !session.knownStores.some((known) => known.id === store.id)) {
        session.knownStores.push(store);
      }
    }
  };

  const registerAndPersist = async (storeId: string): Promise<void> => {
    if (!pending) throw new Error("No pending login to persist.");
    await selectStore(deps.hermesBaseUrl, pending.accessToken, storeId);
    deps.store.write({
      accessToken: pending.accessToken,
      refreshToken: pending.refreshToken,
      expiresAt: pending.expiresAt,
      storeId,
    });
  };

  // Registers + persists, then settles the completion promise either way — success or
  // failure. A storeLogin failure (network blip, a 403, a 500) is treated as terminal
  // rather than retryable: nothing here will retry it for us, and login.ts is already
  // awaiting completion, so leaving it unsettled would hang the CLI forever.
  const finish = async (res: http.ServerResponse, storeId: string): Promise<void> => {
    try {
      await registerAndPersist(storeId);
    } catch (err) {
      html(res, 502, renderEmailForm(
        `Could not register store "${storeId}" with Hermes: ${err instanceof Error ? err.message : String(err)}. ` +
          `Please run the login command again.`
      ));
      settle(false);
      return;
    }
    html(res, 200, renderDone());
    settle(true);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/") {
          html(res, 200, renderEmailForm());
          return;
        }

        if (req.method === "POST" && req.url === "/request-otp") {
          const body = await readBody(req);
          const email = body.email ?? "";
          await sendOtp(deps.hermesBaseUrl, email);
          html(res, 200, renderOtpForm(email));
          return;
        }

        if (req.method === "POST" && req.url === "/verify-otp") {
          const body = await readBody(req);
          const email = body.email ?? "";
          let result;
          try {
            result = await login(deps.hermesBaseUrl, email, body.otp ?? "");
          } catch (err) {
            // A wrong or expired code is worth retrying on the same screen.
            html(res, 200, renderOtpForm(email, err instanceof Error ? err.message : String(err)));
            return;
          }
          const session: PendingLogin = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt,
            isAdmin: result.isAdmin,
            knownStores: [],
          };
          rememberStores(session, result.stores);
          pending = session;

          if (deps.presetStoreId) {
            // An admin's login list is empty because they can reach every store, so
            // there is no list to check the flag against. Hermes is the authority
            // either way: finish() registers the store before anything is persisted,
            // and a store this account may not use fails that call.
            if (!session.isAdmin && !isKnownStore(session.knownStores, deps.presetStoreId)) {
              const available = session.knownStores.map((store) => store.id).join(", ") || "none";
              html(res, 400, renderEmailForm(
                `Store "${deps.presetStoreId}" is not available to this account. Available store ids: ${available}.`
              ));
              // A bad --store flag will not fix itself on retry — don't let the CLI hang forever.
              settle(false);
              return;
            }
            await finish(res, deps.presetStoreId);
            return;
          }

          if (session.knownStores.length === 1) {
            await finish(res, session.knownStores[0].id);
            return;
          }

          // An admin gets no store list from Hermes — they search for one instead.
          // Anyone else with no list has nothing to pick and nothing to search, so
          // say so rather than serving an empty picker the CLI would wait on forever.
          if (session.knownStores.length === 0 && !session.isAdmin) {
            html(res, 403, renderMessage(
              "No stores available",
              "This account cannot access any store. Ask the Vajro support team for access, then run the login again."
            ));
            settle(false);
            return;
          }

          html(res, 200, renderStorePicker({ stores: session.knownStores, canSearch: session.isAdmin }));
          return;
        }

        if (req.method === "POST" && req.url === "/search-stores") {
          const body = await readBody(req);
          const session = pending;
          if (!session || !session.isAdmin) {
            html(res, 400, renderEmailForm("Log in again."));
            return;
          }
          const query = body.query ?? "";
          let results: LoginStore[];
          try {
            results = await findStores(deps.hermesBaseUrl, session.accessToken, query);
          } catch (err) {
            // The session is still good — only this search failed, so keep the
            // picker up rather than sending them back through the OTP.
            html(res, 200, renderStorePicker({
              stores: [],
              canSearch: true,
              query,
              error: `Store search failed: ${err instanceof Error ? err.message : String(err)}`,
            }));
            return;
          }
          rememberStores(session, results);
          html(res, 200, renderStorePicker({ stores: results, canSearch: true, query }));
          return;
        }

        if (req.method === "POST" && req.url === "/select-store") {
          const body = await readBody(req);
          if (!pending || !body.storeId || !isKnownStore(pending.knownStores, body.storeId)) {
            html(res, 400, renderEmailForm("Log in again."));
            return;
          }
          await finish(res, body.storeId);
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      } catch (err) {
        html(res, 200, renderEmailForm(err instanceof Error ? err.message : String(err)));
      }
    })();
  });

  return new Promise<LoginServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      const bound = server.address() as AddressInfo;
      resolve({
        address: bound.address,
        port: bound.port,
        close: () =>
          new Promise<void>((done) => {
            settle(false);
            server.close(() => done());
          }),
        waitForCompletion: () => completion,
      });
    });
  });
};
