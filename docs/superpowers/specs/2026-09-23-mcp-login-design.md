# Browser login for the published MCP

**Date:** 2026-09-23
**Status:** proposed, awaiting review

## What this is for

The server is going public on npm. Today a merchant gets it working by opening
the Vajro dashboard, opening devtools, and copying `STORE_ACCESS_TOKEN` and
`STORE_ID` out of `localStorage` into a `.env` file. That is a developer's
workaround, not an onboarding flow, and it fails in three ways that matter for
a public release:

- most merchants will not do it at all;
- the token expires in hours, so they must do it again, by hand, repeatedly;
- nothing tells them *why* their tools suddenly return `UNAUTHENTICATED`.

This replaces all of it with one tool, `hermes_setup`, that opens a browser,
takes an email and an emailed code, lets the merchant pick a store, and then
keeps the session alive on its own — refreshing before expiry, and asking for a
fresh sign-in only when the refresh token itself has died.

Success looks like: a merchant installs the package, their agent calls
`hermes_setup`, they finish in a browser tab, and they do not think about
credentials again until something genuinely expires.

### Decisions taken before this was written

1. **CLI/browser login, not a paste-the-token flow.** Chosen over reusing the
   Shopify session exchange and over formalising the manual paste.
2. **Credentials persist to a file** at `~/.hermes-mcp/credentials.json`, mode
   `0600`, with an equivalent per-user ACL on Windows. Chosen over the OS
   keychain (native dependency, fails on headless Linux) and over a
   keychain-with-fallback (two storage guarantees to explain, two to test).
3. **One tool, not several.** `hermes_setup` both reports status and performs
   login; there is no separate `hermes_status`.

## Hard constraint #2 is withdrawn for stdio, and only for stdio

`README.md` states: *"Never persist a credential. Credentials arrive per call
and live only for the duration of that call."*

That is correct for the shared HTTP service, where persistence would mean one
process holding many merchants' credentials, and a request that forgot its own
would act as whichever merchant happened to be stored. It is wrong for a
single-user CLI, where "stay signed in" is the entire feature.

So the constraint narrows rather than disappears:

- **stdio, `HERMES_SINGLE_USER=1`** — persists one merchant's session to disk.
- **stdio, shared (the ai-agent's child process)** — never reads or writes the
  store. Credentials still arrive per call in `_meta`.
- **HTTP (`src/httpServer.ts`)** — never reads or writes the store, structurally.
  `createHandler` does not construct a `CredentialStore` at all, the same way it
  already refuses the environment fallback.

The README constraint is rewritten to say this, rather than deleted, so later
code is not written as though the old rule still held.

## The flow

`hermes_setup` takes no arguments.

**Already signed in, session usable** — returns without opening anything:

```
Signed in as usr_0rje7jndtea1d on SuperHero-vjro (str_0hpxwcdnd2m19).
Access token valid for another 3h 42m.
```

**Not signed in, or the refresh token is dead** — starts a loopback server,
opens the browser, and returns immediately:

```
Opened your browser to http://127.0.0.1:53124/?k=<nonce>
Finish signing in there, then call this tool again to confirm.
```

The tool does **not** block until login completes. An MCP tool call that waits
several minutes on human input is a hung tool call: the client cannot show the
browser, the agent cannot do anything else, and many clients time out. Returning
immediately and letting the agent re-check is the honest shape.

### The four screens

Each screen is a server-rendered HTML form that POSTs and redirects.

```
GET  /?k=<nonce>     Email        → POST /email  → 303 /otp
GET  /otp            Code         → POST /otp    → 303 /store  or  303 /done
GET  /store          Store picker → POST /store  → 303 /done
GET  /done           "You're signed in. You can close this tab."
```

Which store the merchant ends up on, in all four cases:

| `stores` | `isAdmin` | Screen |
|---|---|---|
| one entry | either | Skipped — it selects itself |
| more than one | either | A list to pick from |
| empty | `true` | A text field for a store id; an admin's payload carries no stores, so offering an empty list would be a lie |
| empty | `false` | No store screen. Login stops with "This account has no stores. Ask an admin to add you to one." — there is nothing to pick, and sending them to an empty list would look like a bug in the tool rather than a fact about their account |

### Tokens never enter the browser

The page collects an email and a code and posts them to the loopback server. The
**MCP process** calls Hermes and holds the result. Nothing sensitive is ever put
in a URL, a redirect target, a query string or a page body, so nothing can leak
through browser history, a referer header, or a screenshot.

### Loopback server rules

- Binds `127.0.0.1` on an OS-assigned port. Never `0.0.0.0`.
- The opening URL carries a single-use nonce; every request must present it, or
  it is refused with 403. Without this, any local process could drive the login.
- Shuts down on success, and unconditionally after **5 minutes**. A login server
  that outlives its login is an open door.
- Exactly one at a time. A second `hermes_setup` while one is pending returns
  the existing URL rather than starting a rival server.

## Components

| File | Responsibility |
|---|---|
| `src/auth/credentialStore.ts` | Read/write/clear `~/.hermes-mcp/credentials.json`; owns file mode and Windows ACL. Knows nothing about HTTP. |
| `src/auth/hermesLogin.ts` | The three Hermes calls, behind one interface. The only place the login wire format is spelled out. |
| `src/auth/loginServer.ts` | The loopback server, the nonce, the four routes, the 5-minute lifetime. |
| `src/auth/pages.ts` | HTML for the four screens. Pure functions, string in / string out. |
| `src/tools/setup.ts` | Registers `hermes_setup`; decides "already fine" vs "open a browser". |

`src/auth/` is a new directory because none of this belongs in `registry/`
(OpenAPI shapes) or `tools/` (Hermes operations), and because a subsystem that
touches the filesystem, the network and a browser deserves its own boundary.

### The Hermes adapter

`hermesLogin.ts` exposes exactly what the flow needs:

```ts
export interface LoginSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;          // epoch ms
  userId: string;
  stores: { id: string; name: string }[];
  isAdmin: boolean;
}

export interface HermesLogin {
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<LoginSession>;
}
```

`sendCode` is known: `POST /api/v1/otp/email/send {email}` — verified live,
returns `201 {"data":{"message":"Otp sent successfully"}}`.

`verifyCode` is **not yet known**, and this spec does not guess it. What is
established: `POST /api/v1/auth/web` exists, takes `{domain}`, and answers
`401 {"code":1240,"detail":"Invalid credentials"}` when called without a
credential — so a verified OTP must yield something that call carries. The
remaining work is to observe one real login (the dashboard's Network tab, or a
live run with a real code) and write those one or two requests into this one
method. Nothing else in the design depends on their shape.

This is why the adapter exists as its own file: every other component is built
and tested against the `HermesLogin` interface, so the unknown is confined to a
single function rather than spread through the feature.

## Keeping the session alive

Three cases, in the order they are checked on each tool call:

1. **Access token near expiry** — `isStale` in `src/tokenRefresh.ts` already
   defines this as `Date.now() >= expiresAt - EXPIRY_SKEW_MS` (60s). Reuse that
   constant; do not introduce a second one. Refresh first, then send.
   `TokenCache.accessTokenFor` already does this
   and is already tested; the change is that a refreshed session is now also
   written back to the store, so the next process start inherits it.
2. **Hermes rejects it anyway** — one forced refresh and one retry. Already
   built (`sendWithRenewal`), unchanged.
3. **The refresh token itself is dead** — the case of leaving the MCP unused for
   a day. `refreshAccessToken` already raises `SessionExpiredError`. That now
   also **clears the stored credentials**, so the server stops presenting a
   credential it knows is dead, and every tool answers:

   ```
   [SESSION_EXPIRED] Your Hermes session has ended. Call hermes_setup to sign in again.
   ```

   The message names the tool deliberately: the agent reading it needs to know
   the remedy, and "sign in again" without naming how is a dead end.

## Error handling

| Situation | Behaviour |
|---|---|
| Email rejected by Hermes | Re-render the email screen with Hermes' own message. Never invent one. |
| Wrong code | Re-render the code screen; the code stays usable until Hermes says otherwise. |
| Hermes unreachable during login | Screen shows the failure and offers retry. The loopback server stays up until its 5 minutes are out. |
| Nonce missing or wrong | `403`, no body. Nothing is revealed about whether a login is in progress. |
| Browser cannot be opened | The tool's return text carries the URL; the merchant opens it by hand. Never a silent failure. |
| Port cannot be bound | The tool returns the OS error. No retry loop — a machine that cannot bind a loopback port has a problem this tool cannot fix. |
| Credentials file unreadable or corrupt | Treated as "not signed in". A corrupt file is never a reason to refuse to work. |
| Credentials file cannot be written | Login still succeeds for this process, and the return text says it will not survive a restart. |

## Testing

Unit, with a fake `HermesLogin` and a temp `HOME`:

- a valid session in the store is reported without starting a server
- an expired-but-refreshable session refreshes rather than prompting login
- a dead refresh token clears the store and yields `SESSION_EXPIRED` naming `hermes_setup`
- the store is written `0600`; on Windows, the ACL grants only the current user
- a corrupt credentials file reads as "not signed in" rather than throwing
- one store auto-selects; two prompt; zero-with-`isAdmin` prompts for an id
- a refreshed session is written back to the store

Loopback server, over real HTTP against `127.0.0.1`:

- a request without the nonce is `403`
- a request with the nonce walks email → code → store → done
- the server is listening before the tool returns, and closed after `/done`
- the server closes itself after its deadline with no login
- a second `hermes_setup` returns the pending URL instead of a second server
- no token string appears in any response body, redirect `Location`, or URL

Isolation, at the seams that must not persist:

- `createHandler` (HTTP) never constructs a credential store
- a shared stdio process (`HERMES_SINGLE_USER` unset) never reads or writes it

## Out of scope

- Phone/SMS OTP. `POST /api/v1/otp-login/verify-phone` exists; email is the ask.
- Switching stores without signing out. `hermes_setup` re-run covers it.
- Multiple simultaneous accounts in one credentials file.
- Any login path for the HTTP transport.
- Encrypting the credentials file. File permissions are the boundary; a local
  attacker who can read your home directory as you has already won.
