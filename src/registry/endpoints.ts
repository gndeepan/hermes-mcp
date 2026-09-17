import type { EndpointDef } from "./schemaFromOpenApi.js";

/**
 * The complete set of Hermes operations this server will ever call (hard
 * constraint #3). Nothing outside this list is reachable, however the live
 * OpenAPI document changes.
 *
 * `description` is the only thing a calling model sees before choosing a tool,
 * so each one states what the tool returns, what it is for, and how it relates
 * to its neighbours — a name and an HTTP verb are not enough to pick correctly
 * between, say, a page, a widget and a custom block. Parameter-level help is
 * *not* written here: it is compiled from Hermes's own OpenAPI document and
 * refreshed live, so duplicating it would go stale silently.
 *
 * Domain vocabulary these descriptions assume:
 * - **theme** — one merchant app's design: ordered pages, plus brand tokens.
 * - **page** — one screen of a theme (home, PLP, PDP, cart…), holding widgets.
 * - **widget** — one configurable section on a page, of a fixed widget type.
 * - **custom block** — merchant-authored HTML (or a hosted URL) shown as a
 *   full screen, an embedded section, or a popup. Unlike a widget, its body is
 *   authored content rather than configuration of a built-in type.
 */
export const ENDPOINTS: EndpointDef[] = [
  {
    toolName: "hermes_get_active_theme",
    method: "get",
    pathTemplate: "/api/v1/themes/active",
    description:
      "Get the theme that is currently live in the store's mobile app, including its id, name and configuration (brand colours, typography and other design tokens). Takes no arguments — the store is determined by the credentials on the call, not by an argument. This is the usual entry point: call it first to discover the active theme id, then pass that id to hermes_list_pages or hermes_list_theme_versions. It is also the source of the design tokens any new custom block should match.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_theme",
    method: "get",
    pathTemplate: "/api/v1/themes/{id}",
    description:
      "Get one theme by its id, including its name and configuration. Use this to inspect a theme that is not the live one — for example a draft, or a theme whose id came from hermes_list_theme_versions. To read the theme currently live in the app, call hermes_get_active_theme instead, which needs no id.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_theme_versions",
    method: "get",
    pathTemplate: "/api/v1/themes/{themeId}/versions",
    description:
      "List the saved versions (the publish/save history) of one theme. Returns version records, not full theme content — use the ids from here with hermes_get_theme to read a specific version's configuration. Useful for answering what changed, when a theme was last published, or which version to compare against. This tool is read-only and cannot restore or roll back a version.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_pages",
    method: "get",
    pathTemplate: "/api/v1/themes/{id}/pages",
    description:
      "List the pages that belong to one theme, in their configured order — the screens of the merchant's app, such as home, product listing, product detail, cart and account. Returns each page's id, type and metadata, which is how you map a screen a merchant describes in words onto the page id the other tools need. Take the theme id from hermes_get_active_theme. For the widgets on a page, follow up with hermes_get_page.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_page",
    method: "get",
    pathTemplate: "/api/v1/pages/{id}",
    description:
      "Get one page by its id, with the ordered widgets it contains and their configuration. This is how you see what is actually on a screen and find the id of a widget to inspect or change. Page ids come from hermes_list_pages. To change a widget found here, use hermes_update_widget — this tool is read-only.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_custom_blocks",
    method: "get",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
    description:
      "List a store's custom blocks — the merchant-authored HTML or hosted-URL blocks shown as full screens, embedded sections or popups. Results are paged (pass the 1-based page number) and can be narrowed by presentation type, content type, the screen the block is segregated to, or a case-insensitive substring of the block name. Returns block summaries; call hermes_get_custom_block for one block's full content. Use this before creating a block, both to check whether one already exists and to read existing blocks as precedent for the store's own naming and markup conventions.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_custom_block",
    method: "get",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks/{id}",
    description:
      "Get one custom block by id, including its full content (the HTML source, or the URL for a URL block) and its config, such as the input fields the merchant can fill in. Always read a block with this tool before calling hermes_update_custom_block: that update replaces the block's content wholesale, so you need the current content first to avoid discarding it. Block ids come from hermes_list_custom_blocks.",
    hasBody: false,
  },
  {
    toolName: "hermes_create_custom_block",
    method: "post",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
    description:
      "Create a new custom block in a store and return the created block, including its new id. This is a write to the merchant's live app data — confirm the intent before calling it, and check hermes_list_custom_blocks first so you do not create a near-duplicate of an existing block. Hermes validates the body and rejects an invalid one; this tool does not re-validate it.",
    hasBody: true,
    bodyDescription:
      "Hermes's CreateCustomBlockDto. Required: name (what the merchant sees in their block list); type — the presentation, one of FULLSCREEN, EMBEDDED, POPUPCENTER, POPUPBOTTOM, IMMERSIVE; contentType — HTML for authored markup or URL for a hosted page; segregationType — the screen the block belongs to, one of HOME, PLP, PDP, CART, CUSTOM, ACCOUNT, ALL; and content — the HTML source when contentType is HTML, or the URL to load when it is URL. Optional: collapseType, the dismissal behaviour of a popup, one of COLLAPSENONE, COLLAPSECLOSE, COLLAPSENODISMISS; and config, which carries inputFields — the fields the merchant can edit on this block.",
  },
  {
    toolName: "hermes_update_custom_block",
    method: "put",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks/{id}",
    description:
      "Replace an existing custom block and return the updated block. This is a full replacement, not a patch: every required field must be sent on every call, and any field you omit is not preserved from the stored block. Read the block with hermes_get_custom_block first, change only what you mean to change, and send the merged result. This writes to the merchant's live app data, so confirm the intent before calling it.",
    hasBody: true,
    bodyDescription:
      "Hermes's UpdateCustomBlockDto — the same shape as create, sent in full. Required: name; type, one of FULLSCREEN, EMBEDDED, POPUPCENTER, POPUPBOTTOM, IMMERSIVE; contentType, HTML or URL; segregationType, one of HOME, PLP, PDP, CART, CUSTOM, ACCOUNT, ALL; and content, the HTML source or the hosted URL. Optional: collapseType, one of COLLAPSENONE, COLLAPSECLOSE, COLLAPSENODISMISS; and config, carrying the block's inputFields.",
  },
  {
    toolName: "hermes_get_widget",
    method: "get",
    pathTemplate: "/api/v1/widgets/{id}",
    description:
      "Get one widget by id — a single configurable section on a page, with its type, configuration, translations and whether it is currently displayed. Widget ids come from hermes_get_page. Read a widget with this tool before changing it with hermes_update_widget, so you can send back a complete, merged body.",
    hasBody: false,
  },
  {
    toolName: "hermes_update_widget",
    method: "put",
    pathTemplate: "/api/v1/widgets/{id}",
    description:
      "Update one widget and return the updated widget — used to show or hide a section, rename it, or change its configuration or translations. Send the full intended state: read the widget with hermes_get_widget first and merge your change into it, because omitted fields are not carried over from the stored widget. A widget's type cannot be changed here. This writes to the merchant's live app, so confirm the intent before calling it.",
    hasBody: true,
    bodyDescription:
      "Hermes's UpdateWidgetDto. Required: display — true to show this widget on its page, false to hide it. Optional: name, the label shown in the editor; config, the widget's own type-specific settings object; and translations, the per-locale text overrides, keyed by locale.",
  },
];
