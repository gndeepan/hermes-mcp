import * as z from "zod";
import { MissingOperationError } from "../errors.js";

export interface OpenApiParameterSchema {
  type?: string;
  enum?: string[];
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: OpenApiParameterSchema;
}

export interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: unknown;
}

export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
  patch?: OpenApiOperation;
}

export interface OpenApiDocument {
  paths: Record<string, OpenApiPathItem>;
}

export type HttpMethod = "get" | "post" | "put" | "delete";

export interface EndpointDef {
  toolName: string;
  method: HttpMethod;
  pathTemplate: string;
  description: string;
  hasBody: boolean;
  bodyDescription?: string;
}

export interface CompiledEndpoint extends EndpointDef {
  inputSchema: z.ZodObject<Record<string, z.ZodTypeAny>>;
  paramLocations: Record<string, "path" | "query">;
}

const paramSchemaToZod = (schema: OpenApiParameterSchema | undefined): z.ZodTypeAny => {
  if (schema?.enum && schema.enum.length > 0) {
    const [first, ...rest] = schema.enum;
    return z.enum([first, ...rest]);
  }
  if (schema?.type === "integer" || schema?.type === "number") return z.coerce.number();
  if (schema?.type === "boolean") return z.coerce.boolean();
  return z.string();
};

export const compileEndpoint = (doc: OpenApiDocument, entry: EndpointDef): CompiledEndpoint => {
  const operation = doc.paths[entry.pathTemplate]?.[entry.method];
  if (!operation) {
    throw new MissingOperationError(entry.toolName, entry.method, entry.pathTemplate);
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const paramLocations: Record<string, "path" | "query"> = {};

  for (const param of operation.parameters ?? []) {
    if (param.in !== "path" && param.in !== "query") continue;
    let field = paramSchemaToZod(param.schema).describe(param.description ?? param.name);
    if (!param.required) field = field.optional();
    shape[param.name] = field;
    paramLocations[param.name] = param.in;
  }

  if (entry.hasBody) {
    // `.meta()` rather than `.describe()`: Zod renders an unknown value type as
    // `additionalProperties: {}`, the object-literal spelling of `true`, which
    // schema-portability checkers (the MCP Inspector's `--strict` among them)
    // flag as "carries no validation keyword at all". The body genuinely is
    // free-form — Hermes validates its shape and this tool deliberately does
    // not — so `additionalProperties: true` says that outright instead of by
    // implication. Parsing behaviour is unchanged.
    shape.body = z.record(z.string(), z.unknown()).meta({
      description:
        entry.bodyDescription ?? "Request body. Hermes validates its shape; this tool does not re-validate it.",
      additionalProperties: true,
    });
  }

  return { ...entry, inputSchema: z.object(shape), paramLocations };
};
