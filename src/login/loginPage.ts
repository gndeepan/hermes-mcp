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
  .store button { margin-top: 0.5rem; text-align: left; }
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

export const renderStorePicker = (stores: LoginStore[]): string =>
  page(`
  <h1>Pick a store</h1>
  ${stores
    .map(
      (store) => `<form class="store" method="post" action="/select-store">
    <input type="hidden" name="storeId" value="${escapeHtml(store.id)}">
    <button type="submit">${escapeHtml(store.name)} — ${escapeHtml(store.domain)}</button>
  </form>`
    )
    .join("\n")}`);

export const renderDone = (): string =>
  page(`
  <h1>Logged in</h1>
  <p>Credentials saved. You can close this tab and start the MCP server.</p>`);
