import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { HermesUnauthenticatedError, toToolResult } from "../errors.js";
import { clearEnvCredentials } from "../envFile.js";
import { callAssertsIdentity, type EnvCredentials, type UserContext } from "../userContext.js";
// Types only, for the same reason as `gateway.ts`: `index.ts` imports this
// module, so the runtime helpers it needs arrive as `deps`.
import type { CallContext, ToolContext, ToolReturn } from "./index.js";

export interface AccountDeps {
  callHermes: (
    ctx: ToolContext,
    call: CallContext,
    prepare: (user: UserContext) => (acting: UserContext) => Promise<unknown>,
    onRenewal: (reason: "expired" | "rejected") => void
  ) => Promise<unknown>;
  canSignIn: (ctx: ToolContext, call: CallContext) => boolean;
  fallbackCredentials: (ctx: ToolContext) => EnvCredentials | null;
}

export const WHOAMI_TOOL = "hermes_whoami";
export const LOGOUT_TOOL = "hermes_logout";

const WHOAMI_DESCRIPTION =
  "Show who is signed in to Hermes: the user's id, name, email, status, role, admin flag and last login, the " +
  "store this session acts on, every store the user can access, where the session came from, when its " +
  "access token expires and how many minutes are left, and the Hermes base URL and OpenAPI docs URL this " +
  "server is using. Read-only, and never returns a token. If nobody is signed in it says so and " +
  "opens nothing.";

const LOGOUT_DESCRIPTION =
  "Sign out of Hermes on this machine. Clears the saved sign-in (~/.hermes-mcp/credentials.json), every " +
  "renewed token this server holds in memory, any sign-in still waiting in the browser, and the Hermes " +
  "token and store values in the .env file this server loaded, so a restart does not sign back in. The next " +
  "hermes_* call opens the browser sign-in again. Confirm with the user before calling. Hermes has no " +
  "logout endpoint, so tokens already issued are not revoked on the server; they are only removed here.";

const text = (body: string): ToolReturn => ({ content: [{ type: "text", text: body }] });

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isoOrNull = (millis: unknown): string | null =>
  typeof millis === "number" && Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : null;

/**
 * Whole minutes left on a token, floored at zero, or null when there is no
 * expiry to count down to (a token pasted into `.env` carries none).
 */
const minutesUntil = (millis: unknown): number | null =>
  typeof millis === "number" && Number.isFinite(millis) && millis > 0
    ? Math.max(0, Math.floor((millis - Date.now()) / 60_000))
    : null;

/** Hermes' profile fields, named explicitly so nothing it adds later leaks through unreviewed. */
const profileFrom = (me: unknown) => {
  const m = asRecord(me);
  return {
    id: m.id ?? null,
    name: m.name ?? null,
    email: m.email ?? null,
    status: m.status ?? null,
    isAdmin: m.isAdmin ?? null,
    roleId: m.roleId ?? null,
    permissions: m.permissions ?? null,
    lastLoggedInAt: isoOrNull(m.lastLoggedInAt),
  };
};

/**
 * The user's stores, as id, name and domain only.
 *
 * Hermes' store record also carries `sfAccessToken`, the Shopify storefront
 * token. It is a credential, and a "who am I" answer is exactly the kind of
 * output that gets pasted into a chat or a ticket — so it is dropped here by
 * construction, not filtered out later.
 */
const storesFrom = (stores: unknown): { id: string; name: string; domain: string | null }[] =>
  (Array.isArray(stores) ? stores : []).flatMap((entry) => {
    const s = asRecord(entry);
    if (typeof s.id !== "string" || s.id === "") return [];
    return [
      {
        id: s.id,
        name: typeof s.name === "string" && s.name !== "" ? s.name : s.id,
        domain: typeof s.domain === "string" && s.domain !== "" ? s.domain : null,
      },
    ];
  });

/** Where this call's identity came from, in words a user recognises. */
const sourceOf = (ctx: ToolContext, call: CallContext): string => {
  if (ctx.httpCredentials !== undefined || callAssertsIdentity(call?.mcpReq?._meta)) return "request";
  if (ctx.config.credentials !== null && ctx.auth?.envRetired !== true) return ".env";
  return "browser sign-in";
};

export const registerAccountTools = (server: McpServer, ctx: ToolContext, deps: AccountDeps): void => {
  server.registerTool(
    WHOAMI_TOOL,
    { description: WHOAMI_DESCRIPTION, inputSchema: z.object({}) },
    (async (_args: Record<string, unknown>, call: CallContext): Promise<ToolReturn> => {
      const traceId = randomBytes(4).toString("hex");
      try {
        // Asking who is signed in must not sign anyone in. Where a sign-in
        // would be the next step, report the fact and leave the choice to the user.
        if (deps.canSignIn(ctx, call) && deps.fallbackCredentials(ctx) === null) {
          return text(
            JSON.stringify({
              signedIn: false,
              message:
                "Nobody is signed in to Hermes. Call hermes_setup, or any other hermes_* tool, to sign in through the browser.",
            })
          );
        }

        let acting: UserContext | undefined;
        const result = await deps.callHermes(
          ctx,
          call,
          () => async (renewed) => {
            acting = renewed;
            const client = ctx.createClient(renewed);
            // Both at once. The store list is a nicety: if it fails for any
            // reason but a dead session, the profile is still the answer.
            const [me, stores] = await Promise.all([
              client.request("GET", "/api/v1/users/me"),
              client.request("GET", "/api/v1/users/me/stores").catch((err: unknown) => {
                if (err instanceof HermesUnauthenticatedError) throw err;
                return null;
              }),
            ]);
            return { me, stores };
          },
          (reason) => ctx.logger.info("renewed hermes session", { tool: WHOAMI_TOOL, traceId, reason })
        );

        const { me, stores } = result as { me: unknown; stores: unknown };
        const storeList = storesFrom(stores);
        const storeId = acting?.storeId ?? null;
        const stored = ctx.auth?.store.read();
        const storeName =
          storeList.find((s) => s.id === storeId)?.name ??
          (stored?.storeId === storeId ? stored?.storeName : undefined) ??
          null;
        const expiresAt = acting?.expiresAt;

        ctx.logger.info("tool call ok", { tool: WHOAMI_TOOL, traceId });
        return text(
          JSON.stringify({
            signedIn: true,
            user: profileFrom(me),
            store: { id: storeId, name: storeName },
            stores: stores === null ? null : storeList,
            session: {
              source: sourceOf(ctx, call),
              accessTokenExpiresAt: isoOrNull(expiresAt),
              accessTokenExpiresInMinutes: minutesUntil(expiresAt),
              renewable: acting?.refreshToken !== undefined,
            },
            // Which Hermes this answer came from. The first thing to check when
            // a user or store is unexpectedly missing is whether the server is
            // pointed at the environment the user signed in to.
            hermes: {
              baseUrl: ctx.config.hermesBaseUrl,
              openApiDocsUrl: ctx.config.openApiDocsUrl,
            },
          })
        );
      } catch (err) {
        return toToolResult(err, ctx.logger, WHOAMI_TOOL);
      }
    }) as Parameters<typeof server.registerTool>[2]
  );

  const auth = ctx.auth;
  // Logout exists only where this process owns a session to end. A shared
  // process holds nobody's session, and a caller's own token is theirs to drop.
  if (auth === undefined) return;

  server.registerTool(
    LOGOUT_TOOL,
    { description: LOGOUT_DESCRIPTION, inputSchema: z.object({}) },
    (async (): Promise<ToolReturn> => {
      try {
        const cleared: string[] = [];

        if (auth.pending.current !== undefined) {
          auth.pending.current.close();
          cleared.push("the sign-in waiting in the browser");
        }

        const stored = auth.store.read();
        auth.store.clear();
        if (stored !== null) cleared.push(`the saved sign-in (${auth.store.path})`);

        ctx.tokens?.clear();

        const envActive = ctx.config.credentials !== null && auth.envRetired !== true;
        // For this process, whatever happens to the file: the credentials are
        // already in memory, and only this flag stops them being used.
        auth.envRetired = true;

        let envNote = "";
        if (envActive) {
          const keys = auth.envFile ? clearEnvCredentials(auth.envFile) : [];
          if (keys.length > 0) {
            cleared.push(`${keys.join(", ")} in ${auth.envFile}`);
          } else {
            // Exported by the shell or the client config rather than read
            // from a file this server can edit.
            cleared.push("the .env credentials, for this run");
            envNote =
              "\nHERMES_ACCESS_TOKEN / HERMES_STORE_ID are set in this server's environment (for example your " +
              "MCP client config), not in a file it can edit. They are ignored until the server restarts; " +
              "remove them there to stay signed out.";
          }
        }

        ctx.logger.info("signed out", { cleared: cleared.length });

        if (cleared.length === 0) {
          return text("Nobody was signed in to Hermes. Nothing to clear.");
        }
        return text(
          `Signed out of Hermes${stored !== null ? ` (${stored.userId} on ${stored.storeName})` : ""}.\n` +
            `Cleared: ${cleared.join("; ")}.` +
            envNote +
            "\nHermes has no logout endpoint, so tokens already issued stay valid there until they expire; " +
            "none are kept on this machine any more. The next hermes_* call opens the browser sign-in."
        );
      } catch (err) {
        return toToolResult(err, ctx.logger, LOGOUT_TOOL);
      }
    }) as Parameters<typeof server.registerTool>[2]
  );
};
