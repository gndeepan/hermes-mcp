import { randomBytes } from "node:crypto";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { MissingOperationError, toToolResult } from "../errors.js";
import { coerceQuery, substitutePath } from "../registry/operations.js";
import { searchOperations } from "../registry/search.js";
import { userContextFrom, type UserContext } from "../userContext.js";
// Types only, so this module does not sit in a runtime import cycle with
// `index.ts`, which imports `registerGatewayTools` from here. The two runtime
// helpers it needs arrive as `deps` instead.
import type { CallContext, ToolContext, ToolReturn } from "./index.js";

/**
 * The two things the gateway borrows from the curated path.
 *
 * Passed rather than imported because `index.ts` imports this module: taking
 * them back by name would close a cycle, and the renewal logic is not something
 * to reimplement for a second caller.
 */
export interface GatewayDeps {
  sendWithRenewal: (
    ctx: ToolContext,
    user: UserContext,
    send: (acting: UserContext) => Promise<unknown>,
    onRenewal: (reason: "expired" | "rejected") => void
  ) => Promise<unknown>;
  assertStoreIds: (candidates: unknown[], user: UserContext) => void;
}

const FIND_DESCRIPTION =
  "Search Hermes' live OpenAPI specification for the operation that answers a question, and return its method, " +
  "path, parameters and request and response schemas. Use this when none of the purpose-built hermes_* tools " +
  "covers what you need — those tools handle themes, pages, widgets and custom blocks with better schemas and " +
  "should always be preferred where they apply. This tool only describes operations; it never calls anything, " +
  "so it is safe to explore with. Follow up with hermes_call_api to invoke what you find. Search by the noun you " +
  "care about (\"user\", \"campaign\", \"market\") rather than by a verb; results are ranked, and the closest " +
  "match comes first.";

const CALL_DESCRIPTION =
  "Invoke any operation in Hermes' OpenAPI specification by its method and path template, for example method " +
  "'get' with path '/api/v1/stores/{id}/info' and pathParams {\"id\": \"str_123\"}. Prefer the purpose-built " +
  "hermes_* tools where they apply; use this for everything they do not cover, normally after hermes_find_api " +
  "has told you the exact path and parameters. Pass the path TEMPLATE with its braces intact and supply every " +
  "placeholder in pathParams. THIS TOOL CAN MODIFY AND DELETE DATA: post, put and delete operations take effect " +
  "immediately and irreversibly, using the caller's own credentials. This server cannot ask a human for " +
  "confirmation — it has no channel to one — so confirm any non-GET call with the user before making it.";

/**
 * The value types each argument really accepts, spelled out.
 *
 * Two things force this to be explicit rather than a convenient `z.unknown()`.
 * A bare `z.unknown()` compiles to a schema with no validation keyword at all —
 * the object-literal spelling of `true` — which advertises a shape while
 * constraining nothing. And a plain union of primitives collapses to
 * `type: ["string","number","boolean"]`, whose array form several MCP clients
 * read as a single string and then either reject the tool or drop the
 * constraint. Per-branch descriptions keep the union as `anyOf`, one `type`
 * each, which every client reads the same way.
 *
 * They also describe what the code already does: `substitutePath` refuses an
 * object and an empty string, and `coerceQuery` drops an object.
 */
const PATH_VALUE = z.union([
  z.string().min(1).describe("an identifier"),
  z.number().describe("a numeric identifier"),
]);

const QUERY_VALUE = z.union([
  z.string().describe("text"),
  z.number().describe("a number"),
  z.boolean().describe("true or false"),
  z.array(PATH_VALUE).describe("a list, sent comma-separated"),
]);

/**
 * Any JSON value, defined recursively so nested objects and arrays are typed
 * all the way down rather than bottoming out in a bare `{}`.
 */
const JSON_VALUE: z.ZodType = z.lazy(() =>
  z.union([
    z.string().describe("text"),
    z.number().describe("a number"),
    z.boolean().describe("true or false"),
    z.array(JSON_VALUE).describe("a list"),
    z.record(z.string(), JSON_VALUE).describe("a nested object"),
  ])
);

/**
 * A request body is an object for 136 of Hermes' 138 body-taking operations,
 * and a top-level array for the other two (`PUT /api/v1/store-switchers` and
 * `PUT /api/v1/multilanguage`). Both spellings are accepted.
 */
const BODY = z.union([
  z.record(z.string(), JSON_VALUE).describe("a JSON object"),
  z.array(JSON_VALUE).describe("a JSON array"),
]);

/** Narrows an argument that should be a JSON object, without throwing on the alternatives. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const registerGatewayTools = (
  server: McpServer,
  ctx: ToolContext,
  deps: GatewayDeps
): void => {
  server.registerTool(
    "hermes_find_api",
    {
      description: FIND_DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .describe("What you are trying to do, in words. For example: user info, list campaigns"),
        method: z
          .enum(["get", "post", "put", "delete"])
          .optional()
          .describe("Restrict results to one HTTP method"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("How many candidates to return. Default 10, maximum 25"),
      }),
    },
    (async (args: Record<string, unknown>): Promise<ToolReturn> => {
      try {
        const result = searchOperations(ctx.specs.operations, ctx.specs.doc, {
          query: String(args.query ?? ""),
          ...(typeof args.method === "string" ? { method: args.method } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });

        ctx.logger.info("api search", {
          tool: "hermes_find_api",
          found: result.candidates.length,
          truncated: result.truncated,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return toToolResult(err, ctx.logger, "hermes_find_api");
      }
    }) as Parameters<typeof server.registerTool>[2]
  );

  server.registerTool(
    "hermes_call_api",
    {
      description: CALL_DESCRIPTION,
      inputSchema: z.object({
        method: z
          .enum(["get", "post", "put", "delete"])
          .describe("The HTTP method, exactly as hermes_find_api reported it"),
        path: z.string().describe("The path TEMPLATE with its braces intact, e.g. /api/v1/users/{id}"),
        pathParams: z
          .record(z.string(), PATH_VALUE)
          .optional()
          .describe("A value for every {placeholder} in the path, e.g. {\"id\": \"str_123\"}"),
        query: z
          .record(z.string(), QUERY_VALUE)
          .optional()
          .describe("Query string parameters. An array is sent comma-separated"),
        body: BODY.optional().describe("JSON request body, for post and put"),
      }),
    },
    (async (args: Record<string, unknown>, call: CallContext): Promise<ToolReturn> => {
      const start = Date.now();
      const traceId = randomBytes(4).toString("hex");
      const method = String(args.method ?? "").toLowerCase();
      const template = String(args.path ?? "");

      try {
        // First, and before any credential is resolved: an operation Hermes does
        // not publish is not a request this server will compose. This is what
        // keeps the gateway bounded by Hermes' own surface rather than making it
        // an arbitrary HTTP client pointed at a trusted host.
        const operation = ctx.specs.operations.get(method, template);
        if (operation === undefined) {
          const near = ctx.specs.operations.nearest(method, template);
          throw new MissingOperationError(
            near.length === 0 ? "hermes_call_api" : `hermes_call_api (did you mean: ${near.join(", ")})`,
            method,
            template
          );
        }

        const pathParams = asRecord(args.pathParams);
        const query = asRecord(args.query);
        const body = args.body;

        const user = userContextFrom(
          call?.mcpReq?._meta,
          ctx.httpCredentials,
          ctx.allowEnvFallback === false ? null : ctx.config.credentials
        );

        // Three places a store id can hide in a gateway call, against one in a
        // curated one. Checked before the path is built, so a cross-tenant call
        // costs nothing and reaches nothing.
        deps.assertStoreIds([args.storeId, pathParams.storeId, asRecord(body).storeId], user);

        const path = substitutePath(template, pathParams);
        const resolvedQuery = coerceQuery(query);

        if (method !== "get") {
          // The one line that makes a destructive call greppable afterwards.
          // Logged before the request, so an interrupted process still shows
          // what it was about to do.
          ctx.logger.warn("gateway write call", {
            tool: "hermes_call_api",
            traceId,
            method,
            path,
            storeId: user.storeId,
          });
        }

        const data = await deps.sendWithRenewal(
          ctx,
          user,
          (acting) => ctx.createClient(acting).request(method, path, { query: resolvedQuery, body }),
          (reason) =>
            ctx.logger.info("renewed hermes session", { tool: "hermes_call_api", traceId, reason })
        );

        ctx.logger.info("tool call ok", {
          tool: "hermes_call_api",
          traceId,
          method,
          durationMs: Date.now() - start,
        });
        // `?? null` is load-bearing. Hermes answers some calls with no body at
        // all, and `JSON.stringify(undefined)` is `undefined`, not a string —
        // which leaves `text` missing and the whole tools/call result invalid
        // against the MCP schema. The client then reports a protocol error
        // rather than the successful empty response it actually got.
        return { content: [{ type: "text", text: JSON.stringify(data ?? null) }] };
      } catch (err) {
        ctx.logger.info("tool call failed", {
          tool: "hermes_call_api",
          traceId,
          durationMs: Date.now() - start,
        });
        return toToolResult(err, ctx.logger, "hermes_call_api");
      }
    }) as Parameters<typeof server.registerTool>[2]
  );
};
