import type { EndpointDef } from "./schemaFromOpenApi.js";

export const ENDPOINTS: EndpointDef[] = [
  {
    toolName: "hermes_get_active_theme",
    method: "get",
    pathTemplate: "/api/v1/themes/active",
    description: "Get the store's currently active theme.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_theme",
    method: "get",
    pathTemplate: "/api/v1/themes/{id}",
    description: "Get one theme by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_theme_versions",
    method: "get",
    pathTemplate: "/api/v1/themes/{themeId}/versions",
    description: "List saved versions of a theme.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_pages",
    method: "get",
    pathTemplate: "/api/v1/themes/{id}/pages",
    description: "List the pages that belong to a theme.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_page",
    method: "get",
    pathTemplate: "/api/v1/pages/{id}",
    description: "Get one page by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_list_custom_blocks",
    method: "get",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
    description:
      "List a store's custom blocks, optionally filtered by type, content type, segregation type or search term.",
    hasBody: false,
  },
  {
    toolName: "hermes_get_custom_block",
    method: "get",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks/{id}",
    description: "Get one custom block by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_create_custom_block",
    method: "post",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
    description: "Create a new custom block.",
    hasBody: true,
    bodyDescription:
      "Mirrors Hermes's CreateCustomBlockDto: name, type, contentType, segregationType and content are required; collapseType and config are optional.",
  },
  {
    toolName: "hermes_update_custom_block",
    method: "put",
    pathTemplate: "/api/v1/stores/{storeId}/custom-blocks/{id}",
    description: "Update an existing custom block.",
    hasBody: true,
    bodyDescription:
      "Mirrors Hermes's UpdateCustomBlockDto: name, type, contentType, segregationType and content are required; collapseType and config are optional.",
  },
  {
    toolName: "hermes_get_widget",
    method: "get",
    pathTemplate: "/api/v1/widgets/{id}",
    description: "Get one widget by id.",
    hasBody: false,
  },
  {
    toolName: "hermes_update_widget",
    method: "put",
    pathTemplate: "/api/v1/widgets/{id}",
    description: "Update a widget.",
    hasBody: true,
    bodyDescription:
      "Mirrors Hermes's UpdateWidgetDto: display is required; config, translations and name are optional.",
  },
];
