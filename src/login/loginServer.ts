import http from "node:http";
import type { AddressInfo } from "node:net";
import { sendEmailOtp, storeLogin, webLogin } from "../auth/hermesAuth.js";
import type { LoginStore } from "../auth/hermesAuth.js";
import type { TokenStore } from "../auth/tokenStore.js";
import { renderDone, renderEmailForm, renderOtpForm, renderStorePicker } from "./loginPage.js";

export interface LoginServerDeps {
  hermesBaseUrl: string;
  store: TokenStore;
  sendOtp?: typeof sendEmailOtp;
  login?: typeof webLogin;
  selectStore?: typeof storeLogin;
  presetStoreId?: string;
}

export interface LoginServer {
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

const isKnownStore = (stores: LoginStore[], id: string): boolean =>
  stores.some((store) => store.id === id);

export const startLoginServer = (deps: LoginServerDeps): Promise<LoginServer> => {
  const sendOtp = deps.sendOtp ?? sendEmailOtp;
  const login = deps.login ?? webLogin;
  const selectStore = deps.selectStore ?? storeLogin;
  let pending: { accessToken: string; refreshToken: string; expiresAt: number; stores: LoginStore[] } | null =
    null;
  let settle: (ok: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

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
          pending = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt,
            stores: result.stores,
          };

          if (deps.presetStoreId) {
            if (!isKnownStore(result.stores, deps.presetStoreId)) {
              const available = result.stores.map((store) => store.id).join(", ") || "none";
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

          if (result.stores.length === 1) {
            await finish(res, result.stores[0].id);
            return;
          }

          html(res, 200, renderStorePicker(result.stores));
          return;
        }

        if (req.method === "POST" && req.url === "/select-store") {
          const body = await readBody(req);
          if (!pending || !body.storeId || !isKnownStore(pending.stores, body.storeId)) {
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
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
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
