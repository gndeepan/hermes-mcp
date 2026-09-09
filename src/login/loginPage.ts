import type { LoginStore } from "../auth/hermesAuth.js";

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string
  );

/** The Superfans wordmark the Dashboard's own login screen loads. */
const LOGO_URL =
  "https://res.cloudinary.com/vajrohq/image/upload/q_auto/v1765299026/modernization/xrumgrtdbb2fyenxkkoa.png";

const page = (body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermes-mcp login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Palette and metrics mirror the Dashboard's design tokens. */
  :root {
    --primary-400: #915ee9;
    --primary-500: #8948df;
    --primary-600: #7935cc;
    --neutral-900: #323234;
    --neutral-500: #8e8f95;
    --secondary-700: #66666e;
    --secondary-600: #7e7f86;
    --secondary-200: #cfd0d3;
    --secondary-300: #babbc0;
    --secondary-050: #efeff0;
    --error-700: #a40d3c;
    font-size: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: #fff;
    color: var(--neutral-900);
    font-family: Figtree, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .shell { width: 100%; max-width: 448px; }
  .brand { font-size: 24px; line-height: 36px; font-weight: 600; margin: 0; }
  .logo { margin: 2rem 0; }
  .logo img { width: 200px; height: auto; display: block; }
  .card {
    padding: 24px;
    background: #fff;
    border: 1px solid var(--secondary-050);
    border-radius: 16px;
    box-shadow: 1px 1px 16px 0 rgba(0, 0, 0, 0.08);
  }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 1rem; }
  p { margin: 0 0 0.75rem; }
  .muted { color: var(--neutral-500); }
  .sent-to { font-weight: 500; color: var(--neutral-500); margin-bottom: 1.5rem; }
  label { display: block; font-size: 14px; font-weight: 500; color: var(--secondary-600); margin-top: 0.75rem; }
  input, select {
    width: 100%;
    min-height: 40px;
    margin-top: 0.25rem;
    padding: 8px 12px;
    font: inherit;
    font-size: 14px;
    color: var(--secondary-700);
    background: #fff;
    border: 1px solid var(--secondary-200);
    border-radius: 8px;
  }
  select { cursor: pointer; }
  input::placeholder { color: var(--secondary-300); }
  input:focus-visible, select:focus-visible { outline: 1px solid #92939b; }
  .otp { display: flex; justify-content: center; gap: 8px; margin-top: 0.5rem; }
  .otp input {
    width: 40px; height: 40px; min-height: 40px; margin-top: 0; padding: 0;
    text-align: center; font-size: 18px;
  }
  .otp input:focus-visible { outline: 1px solid var(--primary-400); }
  hr { border: none; border-top: 1px solid var(--secondary-050); margin: 1.75rem 0; }
  button {
    width: 100%;
    min-height: 36px;
    margin-top: 2rem;
    padding: 8px 16px;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    color: #fff;
    background: var(--primary-400);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { background: var(--primary-500); }
  button:active { background: var(--primary-600); }
  .error { color: var(--error-700); font-size: 12px; margin: 1rem 0 0; }
  .empty { color: var(--neutral-500); font-size: 12px; margin: 1.5rem 0 0; }
  @media (min-width: 640px) { .otp input { width: 48px; height: 48px; min-height: 48px; font-size: 20px; } }
</style>
</head>
<body><main class="shell">
  <p class="brand">Welcome back to</p>
  <div class="logo"><img src="${LOGO_URL}" alt="Superfans" width="200"></div>
  <div class="card">${body}</div>
</main></body>
</html>`;

export const renderEmailForm = (error?: string): string =>
  page(`
  <h1>Log in to Hermes</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/request-otp">
    <label>Email
      <input name="email" type="email" placeholder="name@email.com" required autofocus
             autocomplete="username">
    </label>
    <button type="submit">Login</button>
  </form>`);

/** Eight boxes joined into one hidden field, matching the Dashboard's OTPInput length={8}. */
export const renderOtpForm = (email: string, error?: string): string =>
  page(`
  <h1>Sign In</h1>
  <p class="muted">Enter the verification code sent to:</p>
  <p class="sent-to">${escapeHtml(email)}</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/verify-otp">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <input type="hidden" name="otp" id="otp-value">
    <label>one-time code</label>
    <div class="otp">
      ${Array.from(
        { length: 8 },
        (_, index) =>
          `<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" aria-label="Digit ${
            index + 1
          }"${index === 0 ? " autofocus" : ""}>`
      ).join("\n      ")}
    </div>
    <button type="submit">Verify OTP</button>
  </form>
  <script>
    const boxes = Array.from(document.querySelectorAll(".otp input"));
    const target = document.getElementById("otp-value");
    const sync = () => { target.value = boxes.map((box) => box.value).join(""); };
    boxes.forEach((box, index) => {
      box.addEventListener("input", () => {
        box.value = box.value.replace(/\\D/g, "").slice(0, 1);
        sync();
        if (box.value && index < boxes.length - 1) boxes[index + 1].focus();
      });
      box.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !box.value && index > 0) boxes[index - 1].focus();
      });
      box.addEventListener("paste", (event) => {
        event.preventDefault();
        const digits = (event.clipboardData.getData("text") || "").replace(/\\D/g, "").slice(0, boxes.length);
        digits.split("").forEach((digit, offset) => { boxes[offset].value = digit; });
        sync();
        boxes[Math.min(digits.length, boxes.length - 1)].focus();
      });
    });
  </script>`);

export interface StorePickerView {
  /** The stores to offer: the account's own list, or the results of a search. */
  stores: LoginStore[];
  /** Admins reach stores by searching, so only they get the search box. */
  canSearch: boolean;
  /** Echoed back into the search box so a refined search starts from the last one. */
  query?: string;
  error?: string;
}

const storeLabel = (store: LoginStore): string => {
  const parts = [store.domain, store.appId === undefined ? "" : `app ${store.appId}`].filter(Boolean);
  const suffix = parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
  return `${store.name}${suffix}`;
};

/**
 * A store with no modernization id stays in the list but cannot be chosen — a
 * search that quietly dropped it would look like it found nothing.
 */
const storeOption = (store: LoginStore): string =>
  store.id
    ? `<option value="${escapeHtml(store.id)}">${escapeHtml(storeLabel(store))}</option>`
    : `<option value="" disabled>${escapeHtml(storeLabel(store))} (modernization not enabled)</option>`;

const searchBox = (query: string, autofocus: boolean): string => `
  <form method="post" action="/search-stores">
    <label>Search by store name, tag or app id
      <input name="query" required value="${escapeHtml(query)}" autocomplete="off"${autofocus ? " autofocus" : ""}>
    </label>
    <button type="submit">Search</button>
  </form>`;

const storeDropdown = (stores: LoginStore[], autofocus: boolean): string => `
  <form method="post" action="/select-store">
    <label>Store
      <select name="storeId" required${autofocus ? " autofocus" : ""}>
        <option value="" disabled selected>Choose a store…</option>
        ${stores.map(storeOption).join("\n        ")}
      </select>
    </label>
    <button type="submit">Continue</button>
  </form>`;

export const renderStorePicker = (view: StorePickerView): string => {
  // Only a store that can actually be chosen justifies a dropdown; a result set
  // of nothing but unusable stores gets the empty note instead.
  const choosable = view.stores.some((store) => store.id !== "");
  // Nothing choosable: say why, naming the stores that were found but can't be used.
  const emptyNote =
    view.stores.length > 0
      ? `Found, but not usable — modernization is not enabled for ${view.stores.map(storeLabel).join(", ")}.`
      : view.canSearch && view.query
        ? "No stores matched that search."
        : "No stores to choose from.";
  return page(`
  <h1>Select a Store</h1>
  ${view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : ""}
  ${view.canSearch ? searchBox(view.query ?? "", !choosable) : ""}
  ${view.canSearch && choosable ? "<hr>" : ""}
  ${choosable ? storeDropdown(view.stores, view.canSearch) : `<p class="empty">${escapeHtml(emptyNote)}</p>`}`);
};

/** A terminal state: the page says what happened and offers nothing to click. */
export const renderMessage = (heading: string, body: string): string =>
  page(`
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(body)}</p>`);

export const renderDone = (): string =>
  page(`
  <h1>Logged in</h1>
  <p>Credentials saved. You can close this tab and start the MCP server.</p>`);
