import { describe, expect, it } from "vitest";
import {
  compileEndpoint,
  type EndpointDef,
  type OpenApiDocument,
} from "../../src/registry/schemaFromOpenApi.js";
import { MissingOperationError } from "../../src/errors.js";

const fixtureDoc: OpenApiDocument = {
  paths: {
    "/api/v1/widgets/{id}": {
      get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] },
      put: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {},
      },
    },
    "/api/v1/stores/{storeId}/custom-blocks": {
      get: {
        parameters: [
          { name: "storeId", in: "path", required: true, schema: { type: "string" } },
          { name: "page", in: "query", required: true, schema: { type: "integer" } },
          {
            name: "contentType",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["HTML", "URL"] },
          },
        ],
      },
    },
  },
};

describe("compileEndpoint", () => {
  it("builds required path params and marks their location", () => {
    const entry: EndpointDef = {
      toolName: "hermes_get_widget",
      method: "get",
      pathTemplate: "/api/v1/widgets/{id}",
      description: "Get a widget.",
      hasBody: false,
    };
    const compiled = compileEndpoint(fixtureDoc, entry);
    expect(compiled.paramLocations).toEqual({ id: "path" });
    expect(compiled.inputSchema.safeParse({ id: "w1" }).success).toBe(true);
    expect(compiled.inputSchema.safeParse({}).success).toBe(false);
  });

  it("adds a passthrough body field when hasBody is true", () => {
    const entry: EndpointDef = {
      toolName: "hermes_update_widget",
      method: "put",
      pathTemplate: "/api/v1/widgets/{id}",
      description: "Update a widget.",
      hasBody: true,
    };
    const compiled = compileEndpoint(fixtureDoc, entry);
    expect(compiled.inputSchema.safeParse({ id: "w1", body: { display: true } }).success).toBe(true);
  });

  it("makes an optional enum query param optional and constrained, a required integer required", () => {
    const entry: EndpointDef = {
      toolName: "hermes_list_custom_blocks",
      method: "get",
      pathTemplate: "/api/v1/stores/{storeId}/custom-blocks",
      description: "List custom blocks.",
      hasBody: false,
    };
    const compiled = compileEndpoint(fixtureDoc, entry);
    expect(compiled.paramLocations).toEqual({ storeId: "path", page: "query", contentType: "query" });
    expect(compiled.inputSchema.safeParse({ storeId: "s1", page: 1 }).success).toBe(true);
    expect(compiled.inputSchema.safeParse({ storeId: "s1" }).success).toBe(false);
    expect(
      compiled.inputSchema.safeParse({ storeId: "s1", page: 1, contentType: "BOGUS" }).success
    ).toBe(false);
  });

  it("throws MissingOperationError when the method is absent on an existing path", () => {
    const entry: EndpointDef = {
      toolName: "hermes_delete_widget",
      method: "delete",
      pathTemplate: "/api/v1/widgets/{id}",
      description: "Delete a widget.",
      hasBody: false,
    };
    expect(() => compileEndpoint(fixtureDoc, entry)).toThrow(MissingOperationError);
  });

  it("throws MissingOperationError when the path is absent entirely", () => {
    const entry: EndpointDef = {
      toolName: "hermes_get_theme",
      method: "get",
      pathTemplate: "/api/v1/themes/{id}",
      description: "Get a theme.",
      hasBody: false,
    };
    expect(() => compileEndpoint(fixtureDoc, entry)).toThrow(MissingOperationError);
  });
});
