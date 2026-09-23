/**
 * The four screens of the login flow, as strings.
 *
 * Pure functions on purpose: no server, no state, no I/O. A page is a value,
 * which means every one of them can be asserted on directly — including the
 * property that matters most, that no token ever appears in one.
 */

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * One stylesheet for every screen.
 *
 * Inlined rather than served as a second request: this server exists for about
 * ninety seconds and answers exactly one person, so a stylesheet round-trip is
 * a moving part with nothing to buy. Dark and light both, because a terminal
 * user opening a browser mid-task should not be flashbanged.
 */
const STYLE = `
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#16181d; --muted:#5b6170;
          --line:#e3e6ec; --accent:#365eb0; --accent-fg:#ffffff; --err:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181d; --fg:#f2f4f8; --muted:#9aa2b1; --line:#2c3039;
            --accent:#6f95e0; --accent-fg:#10131a; --err:#f2b8b5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:var(--bg); color:var(--fg);
         font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:min(26rem, 92vw); padding:2rem; }
  h1 { font-size:1.35rem; margin:0 0 .35rem; letter-spacing:-.01em; }
  p  { color:var(--muted); margin:0 0 1.5rem; }
  label { display:block; font-size:.85rem; font-weight:600; margin:0 0 .4rem; }
  input[type=text], input[type=email] {
    width:100%; padding:.7rem .85rem; font:inherit; color:inherit;
    background:transparent; border:1px solid var(--line); border-radius:.5rem; }
  input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:1.1rem; padding:.72rem 1rem; font:inherit; font-weight:600;
           color:var(--accent-fg); background:var(--accent); border:0; border-radius:.5rem; cursor:pointer; }
  button:hover { filter:brightness(1.07); }
  .store { display:flex; gap:.7rem; align-items:center; padding:.7rem .85rem;
           border:1px solid var(--line); border-radius:.5rem; margin-bottom:.5rem; cursor:pointer; }
  .store:has(:checked) { border-color:var(--accent); }
  .store small { display:block; color:var(--muted); font-size:.78rem; }
  .err { color:var(--err); font-size:.88rem; margin:0 0 1rem; }
  .tick { font-size:2.4rem; line-height:1; margin-bottom:.6rem; }
  code { font:0.85rem ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); }
`;

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;

const errorBlock = (message?: string): string =>
  message ? `<p class="err">${escape(message)}</p>` : "";

/** Screen 1 — the email. */
export const emailPage = (nonce: string, error?: string): string =>
  shell(
    "Sign in to Hermes",
    `<h1>Sign in to Hermes</h1>
     <p>We'll email you a one-time code.</p>
     ${errorBlock(error)}
     <form method="post" action="/email">
       <input type="hidden" name="k" value="${escape(nonce)}">
       <label for="email">Work email</label>
       <input id="email" name="email" type="email" required autofocus
              autocomplete="email" placeholder="you@yourstore.com">
       <button type="submit">Send code</button>
     </form>`
  );

/** Screen 2 — the code. */
export const codePage = (nonce: string, email: string, error?: string): string =>
  shell(
    "Enter your code",
    `<h1>Enter your code</h1>
     <p>Sent to ${escape(email)}.</p>
     ${errorBlock(error)}
     <form method="post" action="/otp">
       <input type="hidden" name="k" value="${escape(nonce)}">
       <label for="code">One-time code</label>
       <input id="code" name="code" type="text" required autofocus
              inputmode="numeric" autocomplete="one-time-code" placeholder="123456">
       <button type="submit">Verify</button>
     </form>`
  );

/**
 * Screen 3 — the store.
 *
 * Two shapes rather than one. A merchant with stores picks from them; an admin
 * arrives with an empty list and a store switcher, so they get a field. Showing
 * an admin an empty list would look like a bug in this tool rather than a fact
 * about their account.
 */
export const storePage = (
  nonce: string,
  stores: { id: string; name: string }[],
  error?: string
): string =>
  shell(
    "Choose a store",
    `<h1>Choose a store</h1>
     <p>${stores.length > 0 ? "This is the store the MCP will act on." : "Enter the store you want the MCP to act on."}</p>
     ${errorBlock(error)}
     <form method="post" action="/store">
       <input type="hidden" name="k" value="${escape(nonce)}">
       ${
         stores.length > 0
           ? stores
               .map(
                 (store, i) =>
                   `<label class="store">
                      <input type="radio" name="storeId" value="${escape(store.id)}" ${i === 0 ? "checked" : ""} required>
                      <span>${escape(store.name)}<small>${escape(store.id)}</small></span>
                    </label>`
               )
               .join("")
           : `<label for="storeId">Store ID</label>
              <input id="storeId" name="storeId" type="text" required autofocus placeholder="str_…">`
       }
       <button type="submit">Continue</button>
     </form>`
  );

/** Screen 4 — done. Named for what the merchant did, not for what the server did. */
export const donePage = (storeName: string, persisted: boolean): string =>
  shell(
    "You're signed in",
    `<div class="tick">✓</div>
     <h1>You're signed in</h1>
     <p>Happy to have you using our MCP. You can close this tab and go back to your assistant${
       storeName ? `, which is now acting on <strong>${escape(storeName)}</strong>` : ""
     }.</p>
     ${
       persisted
         ? ""
         : `<p class="err">Your session could not be written to disk, so you'll need to sign in again
            the next time the server restarts.</p>`
     }`
  );

/** Shown when an account has no stores and is not an admin — nothing to pick. */
export const noStoresPage = (): string =>
  shell(
    "No stores on this account",
    `<h1>No stores on this account</h1>
     <p>You signed in, but this account isn't attached to any store, so there's nothing
     for the MCP to act on. Ask an admin to add you to a store, then run
     <code>hermes_setup</code> again.</p>`
  );
