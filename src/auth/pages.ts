/**
 * The screens of the login flow, as strings.
 *
 * Pure functions on purpose: no server, no state, no I/O. A page is a value,
 * which means every one of them can be asserted on directly — including the
 * property that matters most, that no token ever appears in one.
 *
 * They follow the dashboard's own login (`dashboard/apps/platform/src/
 * containers/login/LoginNew.tsx`): "Welcome back to" over the Superfans logo,
 * a white rounded card, Figtree, and the dashboard's primary purple. A merchant
 * signing in here should feel they are signing in to the same product.
 */

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The dashboard's default branding (`getCustomDomainLoadingDetails` in
 * `dashboard/packages/utils/helpers.ts`): the same favicon on the tab and the
 * same light-theme logo above the card. Loaded from where the dashboard loads
 * them, so a rebrand there is a URL change here, not an asset to re-export.
 */
const FAVICON_URL =
  "https://res.cloudinary.com/vajrohq/image/upload/q_auto/v1758518141/modernization/ee9dxyzvn0tvdqirrntc.png";
const LOGO_URL =
  "https://res.cloudinary.com/vajrohq/image/upload/q_auto/v1765299026/modernization/xrumgrtdbb2fyenxkkoa.png";

/**
 * One stylesheet for every screen, inlined.
 *
 * This server exists for about ninety seconds and answers exactly one person,
 * so a stylesheet round-trip is a moving part with nothing to buy. Colours are
 * the dashboard's tokens (`apps/platform/src/index.css`, `tailwind.config.js`),
 * named as it names them. Light only, as the dashboard's login is.
 */
const STYLE = `
  :root { color-scheme: light;
          --primary-25:#f7f4fe; --primary-50:#efebfc; --primary-200:#cbbaf8; --primary-300:#b193f2;
          --primary-400:#915ee9; --primary:#8948df; --primary-600:#7935cc;
          --neutral-900:#323234; --neutral-700:#66666e; --neutral-500:#8e8f95;
          --secondary-25:#f6f6f7; --secondary-50:#efeff0; --secondary-200:#cfd0d3; --secondary-300:#babbc0;
          --error:#e9194e; --error-50:#ffe3e6; --success:#0a915c; --success-50:#d2f9e2;
          --shadow-v1:1px 1px 16px 0px rgba(0,0,0,.08); }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:32px 16px; background:#fff; color:var(--neutral-900);
         background-image:radial-gradient(60rem 40rem at 105% 50%, var(--primary-25), transparent 60%);
         font:14px/20px Figtree, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:448px; }
  .welcome { font-size:24px; line-height:32px; font-weight:600; margin:0; }
  .logo { display:block; margin:32px 0; width:259px; max-width:70%; height:auto; }
  .card { background:#fff; border:1px solid var(--secondary-50); border-radius:16px;
          box-shadow:var(--shadow-v1); padding:24px; }
  h2 { font-size:20px; line-height:28px; font-weight:600; margin:0 0 16px; }
  p { margin:0 0 12px; color:var(--neutral-500); }
  label.field { display:block; font-size:14px; font-weight:500; color:var(--neutral-700); margin:0 0 6px; }
  input[type=text], input[type=email], input[type=search] {
    width:100%; min-height:40px; padding:8px 12px; font:inherit; color:var(--neutral-700);
    background:#fff; border:1px solid var(--secondary-200); border-radius:8px; outline:none;
    transition:border-color .15s, box-shadow .15s; }
  input::placeholder { color:var(--secondary-300); }
  input:focus-visible { border-color:var(--primary-400); box-shadow:0 0 0 1px var(--primary-400); }
  .otp { text-align:center; font-size:20px; letter-spacing:.35em; height:44px; }
  .email-row { display:flex; align-items:center; gap:8px; margin:0 0 24px; font-weight:500; color:var(--neutral-500); }
  .edit { display:inline-flex; padding:6px; border-radius:8px; color:#646464; }
  .edit:hover { background:var(--secondary-25); }
  .btn { position:relative; width:100%; margin-top:32px; min-height:40px; padding:10px 16px;
         display:inline-flex; align-items:center; justify-content:center; gap:8px;
         font:inherit; font-weight:600; color:#fff; background:var(--primary-400);
         border:0; border-radius:8px; cursor:pointer; transition:background-color .2s; }
  .btn:hover { background:var(--primary); }
  .btn:active { background:var(--primary-600); }
  .btn:focus-visible { outline:none; box-shadow:0 0 0 3px var(--primary-200); }
  .btn:disabled { cursor:not-allowed; background:var(--primary-50); color:var(--primary-300); }
  .btn .spin { display:none; }
  .btn.is-loading { pointer-events:none; }
  .btn.is-loading .spin { display:inline-block; }
  .spin { width:16px; height:16px; border-radius:50%; border:2px solid currentColor;
          border-right-color:transparent; animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration:2s; } }
  .link-btn { font:inherit; font-weight:600; color:var(--primary-400); background:none; border:0;
              padding:0 0 0 4px; cursor:pointer; }
  .link-btn:hover { color:var(--primary-600); }
  .resend { display:flex; align-items:center; justify-content:center; margin-top:16px;
            font-size:13px; color:var(--neutral-500); }
  .resend form { display:inline; }
  .banner { border-radius:8px; padding:10px 12px; margin:0 0 16px; font-size:13px; }
  .banner.err { background:var(--error-50); color:var(--error); }
  .banner.ok { background:var(--success-50); color:var(--success); }
  .stores { display:grid; gap:8px; margin-top:12px; max-height:300px; overflow:auto; }
  .store { display:flex; gap:12px; align-items:center; width:100%; text-align:left; padding:10px 12px;
           font:inherit; color:inherit; background:#fff; border:1px solid var(--secondary-200);
           border-radius:8px; cursor:pointer; }
  .store:hover { background:var(--secondary-25); }
  .store:has(:checked), .store[aria-selected=true] { border-color:var(--primary-400); background:var(--primary-25); }
  .store input { accent-color:var(--primary); margin:0; }
  .store small { display:block; color:var(--neutral-500); font-size:12px; line-height:16px; }
  .store[aria-disabled=true] { cursor:not-allowed; opacity:.55; }
  .search { position:relative; }
  .search .spin { position:absolute; right:12px; top:12px; color:var(--primary-400); display:none; }
  .search.searching .spin { display:block; }
  .hint { font-size:12px; color:var(--neutral-500); margin:8px 0 0; min-height:16px; }
  .tick { width:48px; height:48px; border-radius:50%; display:grid; place-items:center;
          background:var(--success-50); color:var(--success); margin-bottom:16px; }
  .foot { font-size:12px; color:var(--neutral-500); text-align:center; margin:16px 0 0; }
  code { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--neutral-700); }
`;

/**
 * Puts every submit button into its loading state when its form is sent.
 *
 * The dashboard's buttons spin while a request is in flight, and these need
 * to more than it does: sending a code or checking one is a round trip to
 * Hermes that can take seconds, and a second click would send a second code.
 * `pageshow` resets the state when the browser restores a page from its cache.
 */
const LOADING_SCRIPT = `
  document.querySelectorAll("form").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      var btn = form.querySelector("button[type=submit]");
      if (!btn) return;
      if (btn.classList.contains("is-loading")) { e.preventDefault(); return; }
      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");
    });
  });
  window.addEventListener("pageshow", function () {
    document.querySelectorAll(".is-loading").forEach(function (btn) {
      btn.classList.remove("is-loading");
      btn.removeAttribute("aria-busy");
    });
  });
`;

const shell = (title: string, card: string, script = ""): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Superfans</title>
<link rel="icon" type="image/png" href="${FAVICON_URL}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap">
<style>${STYLE}</style></head>
<body><main>
  <h1 class="welcome">Welcome back to</h1>
  <img class="logo" src="${LOGO_URL}" alt="Superfans" width="259" height="77">
  <div class="card">${card}</div>
  <p class="foot">This page runs on your computer and closes itself once you're signed in.</p>
</main>
<script>${LOADING_SCRIPT}${script}</script></body></html>`;

const banner = (kind: "err" | "ok", message?: string): string =>
  message ? `<div class="banner ${kind}" role="${kind === "err" ? "alert" : "status"}">${escape(message)}</div>` : "";

/** The dashboard's primary button, with the spinner it shows while loading. */
const submit = (label: string, attrs = ""): string =>
  `<button class="btn" type="submit"${attrs ? ` ${attrs}` : ""}><span class="spin" aria-hidden="true"></span><span>${escape(label)}</span></button>`;

const hiddenNonce = (nonce: string): string => `<input type="hidden" name="k" value="${escape(nonce)}">`;

/** The dashboard's pen icon, for "change email". */
const PEN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" stroke="currentColor" stroke-width="1.8"/></svg>`;

/** Screen 1 — the email. */
export const emailPage = (nonce: string, error?: string): string =>
  shell(
    "Sign in to Hermes",
    `<h2>Sign in to Hermes</h2>
     <p>Connect your AI assistant to your store. We'll email you a one-time code.</p>
     ${banner("err", error)}
     <form method="post" action="/email">
       ${hiddenNonce(nonce)}
       <label class="field" for="email">Email</label>
       <input id="email" name="email" type="email" required autofocus
              autocomplete="email" placeholder="name@email.com">
       ${submit("Login")}
     </form>`
  );

/** Screen 2 — the code. */
export const codePage = (nonce: string, email: string, error?: string, notice?: string): string =>
  shell(
    "Enter your code",
    `<h2>Sign In</h2>
     <p>Enter the verification code sent to:</p>
     <div class="email-row"><span>${escape(email)}</span>
       <a class="edit" href="/?k=${escape(nonce)}" title="Use a different email" aria-label="Use a different email">${PEN_ICON}</a>
     </div>
     ${banner("err", error)}${banner("ok", notice)}
     <form method="post" action="/otp">
       ${hiddenNonce(nonce)}
       <label class="field" for="code">Verification code</label>
       <input id="code" class="otp" name="code" type="text" required autofocus maxlength="8"
              inputmode="numeric" autocomplete="one-time-code" placeholder="********">
       ${submit("Verify OTP")}
     </form>
     <div class="resend">Didn’t receive the code?
       <form method="post" action="/resend">${hiddenNonce(nonce)}<button class="link-btn" type="submit">Resend</button></form>
     </div>`
  );

/** A store as a picker row. Only ever built from Hermes' own list. */
const storeRow = (store: { id: string; name: string }, checked: boolean): string =>
  `<label class="store">
     <input type="radio" name="storeId" value="${escape(store.id)}" ${checked ? "checked" : ""} required>
     <span>${escape(store.name)}<small>${escape(store.id)}</small></span>
   </label>`;

/**
 * JSON for a `<script type="application/json">` block.
 *
 * `<` is escaped so a store name containing `</script>` cannot end the block
 * early — `JSON.parse` reads `<` back as the same character.
 */
const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The admin picker's behaviour: search Hermes as the admin types.
 *
 * It asks this local server (`/stores/search`), never Hermes: the admin's
 * token stays in the MCP process, and the results come back already stripped
 * of the Shopify storefront token Hermes includes. Debounced, and each answer
 * is checked against the latest query so a slow early reply cannot overwrite a
 * later one. Results are rendered with `textContent`, never as HTML.
 */
const ADMIN_SEARCH_SCRIPT = `
  (function () {
    var K = document.querySelector("input[name=k]").value;
    var q = document.getElementById("q");
    var wrap = q.parentNode;
    var list = document.getElementById("stores");
    var hint = document.getElementById("hint");
    var chosen = document.getElementById("storeId");
    var go = document.getElementById("go");
    var initial = JSON.parse(document.getElementById("initial").textContent);
    var timer, seq = 0;

    function select(row, store) {
      list.querySelectorAll(".store").forEach(function (r) { r.setAttribute("aria-selected", "false"); });
      row.setAttribute("aria-selected", "true");
      chosen.value = store.storeId;
      go.disabled = false;
    }

    function render(stores, emptyText) {
      list.textContent = "";
      chosen.value = "";
      go.disabled = true;
      stores.forEach(function (store) {
        var row = document.createElement("button");
        row.type = "button";
        row.className = "store";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        var text = document.createElement("span");
        text.textContent = store.name;
        var sub = document.createElement("small");
        sub.textContent = store.enabled
          ? store.storeId + (store.appId ? " · App ID " + store.appId : "")
          : "Modernization not enabled for this store";
        text.appendChild(sub);
        row.appendChild(text);
        if (store.enabled) {
          row.addEventListener("click", function () { select(row, store); });
        } else {
          row.setAttribute("aria-disabled", "true");
          row.disabled = true;
        }
        list.appendChild(row);
      });
      hint.textContent = stores.length === 0 ? emptyText : "";
    }

    function search(term) {
      var mine = ++seq;
      wrap.classList.add("searching");
      fetch("/stores/search?k=" + encodeURIComponent(K) + "&q=" + encodeURIComponent(term))
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) throw new Error(body.error || "Search failed. Try again.");
            return body;
          });
        })
        .then(function (body) { if (mine === seq) render(body.stores, "No stores match \\u201c" + term + "\\u201d."); })
        .catch(function (err) { if (mine === seq) { render([], ""); hint.textContent = err.message; } })
        .then(function () { if (mine === seq) wrap.classList.remove("searching"); });
    }

    q.addEventListener("input", function () {
      clearTimeout(timer);
      var term = q.value.trim();
      if (term === "") { seq++; wrap.classList.remove("searching"); render(initial, "Type a store name or App ID to search."); return; }
      timer = setTimeout(function () { search(term); }, 300);
    });

    render(initial, "Type a store name or App ID to search.");
  })();
`;

/**
 * Screen 3 — the store.
 *
 * Two shapes, as in the dashboard. A merchant picks from their own stores. An
 * admin can act on any store, so they get the dashboard's search instead —
 * "Enter store ID/store name" — answered live from Hermes, with their own
 * stores (if any) listed before they type.
 */
export const storePage = (
  nonce: string,
  stores: { id: string; name: string }[],
  error?: string,
  isAdmin = false
): string => {
  if (isAdmin || stores.length === 0) {
    const initial = stores.map((s) => ({ storeId: s.id, name: s.name, appId: null, enabled: true }));
    return shell(
      "Choose a store",
      `<h2>Choose a store</h2>
       <p>Enter store ID/store name. This is the store the MCP will act on.</p>
       ${banner("err", error)}
       <form method="post" action="/store">
         ${hiddenNonce(nonce)}
         <input type="hidden" id="storeId" name="storeId" value="">
         <label class="field" for="q">Store</label>
         <div class="search">
           <input id="q" type="search" autocomplete="off" autofocus placeholder="Search a Store"
                  aria-controls="stores">
           <span class="spin" aria-hidden="true"></span>
         </div>
         <p class="hint" id="hint" aria-live="polite"></p>
         <div class="stores" id="stores" role="listbox" aria-label="Stores"></div>
         ${submit("Continue", 'id="go" disabled')}
       </form>
       <script type="application/json" id="initial">${jsonForScript(initial)}</script>`,
      ADMIN_SEARCH_SCRIPT
    );
  }

  return shell(
    "Choose a store",
    `<h2>Choose a store</h2>
     <p>This is the store the MCP will act on.</p>
     ${banner("err", error)}
     <form method="post" action="/store">
       ${hiddenNonce(nonce)}
       <div class="stores">${stores.map((store, i) => storeRow(store, i === 0)).join("")}</div>
       ${submit("Continue")}
     </form>`
  );
};

const CHECK_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Screen 4 — done. Named for what the merchant did, not for what the server did. */
export const donePage = (storeName: string, persisted: boolean): string =>
  shell(
    "You're signed in",
    `<div class="tick">${CHECK_ICON}</div>
     <h2>You're signed in</h2>
     <p>Happy to have you using our MCP. You can close this tab and go back to your assistant${
       storeName ? `, which is now acting on <strong>${escape(storeName)}</strong>` : ""
     }.</p>
     ${banner(
       "err",
       persisted
         ? undefined
         : "Your session could not be written to disk, so you'll need to sign in again the next time the server restarts."
     )}`
  );

/** Shown when an account has no stores and is not an admin — nothing to pick. */
export const noStoresPage = (): string =>
  shell(
    "No stores on this account",
    `<h2>No stores on this account</h2>
     <p>You signed in, but this account isn't attached to any store, so there's nothing
     for the MCP to act on. Ask an admin to add you to a store, then run
     <code>hermes_setup</code> again.</p>`
  );
