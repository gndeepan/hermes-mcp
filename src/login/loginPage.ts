import type { LoginStore } from "../auth/hermesAuth.js";

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );

const page = (body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermes-mcp login</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; max-width: 22rem;
         margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
  label { display: block; margin-top: 0.75rem; font-size: 0.875rem; }
  input { width: 100%; padding: 0.5rem; margin-top: 0.25rem; box-sizing: border-box;
          border: 1px solid #8888; border-radius: 4px; font: inherit; }
  button { margin-top: 1.25rem; padding: 0.625rem 1rem; width: 100%; font: inherit;
           border: 1px solid #8888; border-radius: 4px; cursor: pointer; background: #8881; }
  button:hover { background: #8883; }
  .error { color: #b00020; font-size: 0.875rem; margin-top: 1rem; }
  .empty { color: #8888; font-size: 0.875rem; margin-top: 1.5rem; }
  .store button { margin-top: 0.5rem; text-align: left; }
  .store button[disabled] { cursor: not-allowed; opacity: 0.5; }
</style>
</head>
<body>${body}</body>
</html>`;

export const renderEmailForm = (error?: string): string =>
  page(`
  <h1>Log in to Hermes</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/request-otp">
    <label>Email
      <input name="email" type="email" required autofocus autocomplete="username">
    </label>
    <button type="submit">Email me a code</button>
  </form>`);

export const renderOtpForm = (email: string, error?: string): string =>
  page(`
  <h1>Enter your code</h1>
  <p>We emailed a one-time code to ${escapeHtml(email)}.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/verify-otp">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <label>One-time code
      <input name="otp" required autofocus autocomplete="one-time-code" inputmode="numeric">
    </label>
    <button type="submit">Log in</button>
  </form>`);

export interface StorePickerView {
  /** The stores to offer: the account's own list, or the results of a search. */
  stores: LoginStore[];
  /** Admins reach stores by searching, so only they get the search box. */
  canSearch: boolean;
  /** Echoed back into the search box so a refined search starts from the last one. */
  query?: string;
  error?: string;
}

const storeSubtitle = (store: LoginStore): string => {
  const parts = [store.domain, store.appId === undefined ? "" : `app ${store.appId}`].filter(Boolean);
  return parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
};

const storeChoice = (store: LoginStore): string =>
  store.id
    ? `<form class="store" method="post" action="/select-store">
    <input type="hidden" name="storeId" value="${escapeHtml(store.id)}">
    <button type="submit">${escapeHtml(store.name)}${escapeHtml(storeSubtitle(store))}</button>
  </form>`
    : `<div class="store">
    <button type="button" disabled title="Modernization is not enabled for this store">${escapeHtml(store.name)}${escapeHtml(storeSubtitle(store))}</button>
  </div>`;

const searchBox = (query: string): string => `
  <form method="post" action="/search-stores">
    <label>Find a store by name, tag or app id
      <input name="query" required autofocus value="${escapeHtml(query)}" autocomplete="off">
    </label>
    <button type="submit">Search</button>
  </form>`;

export const renderStorePicker = (view: StorePickerView): string =>
  page(`
  <h1>Pick a store</h1>
  ${view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : ""}
  ${view.canSearch ? searchBox(view.query ?? "") : ""}
  ${
    view.stores.length > 0
      ? view.stores.map(storeChoice).join("\n")
      : `<p class="empty">${view.canSearch && view.query ? "No stores matched that search." : "No stores to choose from."}</p>`
  }`);

/** A terminal state: the page says what happened and offers nothing to click. */
export const renderMessage = (heading: string, body: string): string =>
  page(`
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(body)}</p>`);

export const renderDone = (): string =>
  page(`
  <h1>Logged in</h1>
  <p>Credentials saved. You can close this tab and start the MCP server.</p>`);
