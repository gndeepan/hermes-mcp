import http from "node:http";
import type { AddressInfo } from "node:net";
import { webLogin } from "../auth/hermesAuth.js";
import type { LoginStore } from "../auth/hermesAuth.js";
import type { TokenStore } from "../auth/tokenStore.js";
import { renderDone, renderLoginForm, renderStorePicker } from "./loginPage.js";

export interface LoginServerDeps {
  hermesBaseUrl: string;
  store: TokenStore;
  login?: typeof webLogin;
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

export const startLoginServer = (deps: LoginServerDeps): Promise<LoginServer> => {
  const login = deps.login ?? webLogin;
  let pending: { accessToken: string; refreshToken: string; expiresAt: number } | null = null;
  let settle: (ok: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const persist = (storeId: string): void => {
    if (!pending) throw new Error("No pending login to persist.");
    deps.store.write({ ...pending, storeId });
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/") {
          html(res, 200, renderLoginForm());
          return;
        }

        if (req.method === "POST" && req.url === "/login") {
          const body = await readBody(req);
          const result = await login(
            deps.hermesBaseUrl,
            body.domain ?? "",
            body.email ?? "",
            body.password ?? ""
          );
          pending = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt,
          };

          const only: LoginStore | undefined = result.stores.length === 1 ? result.stores[0] : undefined;
          const storeId = deps.presetStoreId ?? only?.id;
          if (storeId) {
            persist(storeId);
            html(res, 200, renderDone());
            settle(true);
            return;
          }

          html(res, 200, renderStorePicker(result.stores));
          return;
        }

        if (req.method === "POST" && req.url === "/select-store") {
          const body = await readBody(req);
          if (!pending || !body.storeId) {
            html(res, 400, renderLoginForm("Log in again."));
            return;
          }
          persist(body.storeId);
          html(res, 200, renderDone());
          settle(true);
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      } catch (err) {
        html(res, 200, renderLoginForm(err instanceof Error ? err.message : String(err)));
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
