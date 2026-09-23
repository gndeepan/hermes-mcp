import type {
  HttpMethod,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
} from "./schemaFromOpenApi.js";
import { InvalidPathParameterError } from "../errors.js";

/**
 * The methods this server will index. Deliberately not "every key on a path
 * item": a path item also carries `parameters`, `servers`, `summary` and
 * `$ref`, none of which is an operation, and treating them as one would put
 * un-callable entries in front of a model choosing what to call.
 *
 * `patch` is absent because Hermes has none — 141 get, 122 post, 59 put, 34
 * delete, 0 patch. Adding it would advertise a capability the API lacks.
 */
const METHODS: HttpMethod[] = ["get", "post", "put", "delete"];

export interface IndexedOperation {
  method: HttpMethod;
  /** The path *template*, exactly as the document spells it. */
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: OpenApiParameter[];
  operation: OpenApiOperation;
}

/**
 * The identity of an operation.
 *
 * Not `operationId`: Hermes generates those from verbs alone, so the first
 * three in the document are `read`, `update` and `delete_1`. They are not
 * unique across 356 operations and cannot address one.
 */
export const keyOf = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

export class OperationIndex {
  private constructor(private readonly byKey: Map<string, IndexedOperation>) {}

  static fromDocument(doc: OpenApiDocument): OperationIndex {
    const byKey = new Map<string, IndexedOperation>();

    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (item === null || typeof item !== "object") continue;

      // Path-item parameters apply to every operation beneath them, so they are
      // merged in here rather than left for each reader to remember.
      const shared = Array.isArray(item.parameters) ? item.parameters : [];

      for (const method of METHODS) {
        const operation = item[method];
        if (operation === undefined || operation === null || typeof operation !== "object") continue;

        byKey.set(keyOf(method, path), {
          method,
          path,
          summary: typeof operation.summary === "string" ? operation.summary : "",
          description: typeof operation.description === "string" ? operation.description : "",
          tags: Array.isArray(operation.tags)
            ? operation.tags.filter((t): t is string => typeof t === "string")
            : [],
          parameters: [...shared, ...(Array.isArray(operation.parameters) ? operation.parameters : [])],
          operation,
        });
      }
    }

    return new OperationIndex(byKey);
  }

  get(method: string, path: string): IndexedOperation | undefined {
    return this.byKey.get(keyOf(method, path));
  }

  all(): IndexedOperation[] {
    return [...this.byKey.values()];
  }

  /**
   * Keys close to one that did not match, for the error message.
   *
   * The same path under a different verb comes first: an agent that read a
   * find result and mistyped the method is the common case, and naming the
   * verb that does exist turns a dead end into a correction.
   */
  nearest(method: string, path: string, limit = 5): string[] {
    const samePath = this.all()
      .filter((o) => o.path === path)
      .map((o) => keyOf(o.method, o.path));

    const tail = path.split("/").pop();
    const sameTail = this.all()
      .filter((o) => o.path !== path && o.path.split("/").pop() === tail)
      .map((o) => keyOf(o.method, o.path));

    return [...samePath, ...sameTail].slice(0, limit);
  }

  get size(): number {
    return this.byKey.size;
  }
}

const PLACEHOLDER = /\{([^}]+)\}/g;

/**
 * A value made only of dots survives `encodeURIComponent` untouched — `".."`
 * encodes to `".."` — and `new URL(path, base)` in `HermesClient` then applies
 * RFC-3986 dot-segment removal. So `{id}` of `".."` turns
 * `/api/v1/stores/{id}/info` into a request for `/api/v1/info`: an operation
 * that is not in the document, reached after the check that the operation is in
 * the document already passed.
 *
 * `src/tools/index.ts` has guarded the curated path against exactly this since
 * before the gateway existed. Dots are legal inside real Hermes ids, so only a
 * value consisting *entirely* of dots is refused.
 */
const DOT_ONLY = /^\.+$/;

/** The backstop, applied to whatever substitution actually produced. */
const DOT_ONLY_SEGMENT = /(^|\/)\.+(\/|$)/;

/**
 * Fills a path template from caller-supplied values.
 *
 * Every value is percent-encoded, without exception. A path parameter is the
 * one place a caller's string becomes part of the URL's *structure* rather
 * than its content, so a value of `../../admin` or `a/b?x=1` would not be a
 * wrong argument — it would be a different request, to an endpoint nobody
 * chose. Encoding turns it back into what it was meant to be: one segment.
 */
export const substitutePath = (template: string, params: Record<string, unknown>): string => {
  const path = template.replace(PLACEHOLDER, (_match, name: string) => {
    const raw = params[name];
    if (raw === undefined || raw === null) {
      throw new InvalidPathParameterError(template, `no value given for {${name}}`);
    }
    if (typeof raw === "object") {
      throw new InvalidPathParameterError(
        template,
        `{${name}} was given an object, which is not an identifier`
      );
    }
    const text = String(raw).trim();
    if (text === "") {
      throw new InvalidPathParameterError(template, `{${name}} was given an empty value`);
    }
    if (DOT_ONLY.test(text)) {
      throw new InvalidPathParameterError(
        template,
        `{${name}} was given "${text}", which would resolve onto a different path entirely`
      );
    }
    return encodeURIComponent(text);
  });

  // The per-parameter check above names the offending argument, which is the
  // more useful message; this holds whatever the substitution produced,
  // including a dot segment that was already in the template.
  if (DOT_ONLY_SEGMENT.test(path)) {
    throw new InvalidPathParameterError(
      template,
      "the resulting path contains a dot-only segment, which would resolve onto a different operation"
    );
  }
  return path;
};

/**
 * Narrows caller-supplied query values to the strings the transport takes.
 *
 * `HermesClient.request` types `query` as `Record<string, string>`, but a model
 * composing JSON writes `{page: 1}` and `{tags: ["a","b"]}` without thinking
 * about it. Coercing here is the difference between a working call and
 * `?page=[object Object]`, which Hermes rejects with a complaint about a
 * parameter the caller believes it sent correctly.
 *
 * Null and undefined are dropped rather than sent: `?a=null` filters on the
 * literal string "null", which is never what was meant.
 */
export const coerceQuery = (query: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const parts = value.filter((v) => v !== null && v !== undefined && typeof v !== "object");
      if (parts.length > 0) out[key] = parts.map((v) => String(v)).join(",");
      continue;
    }
    if (typeof value === "object") continue;
    out[key] = String(value);
  }
  return out;
};

/**
 * Replaces a `$ref` with the schema it names, one level only.
 *
 * One level is a size decision, not a correctness one. Hermes' component
 * schemas reference each other freely, and following them all for ten
 * candidates would return most of a 760 KB document to answer "is there an API
 * for this". A remaining `{"$ref": "#/components/schemas/Foo"}` is still
 * legible to a model, which can ask about that operation specifically.
 */
export const resolveRefOnce = (doc: OpenApiDocument, schema: unknown): unknown => {
  if (schema === null || typeof schema !== "object") return schema;
  const ref = (schema as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") return schema;

  const prefix = "#/components/schemas/";
  const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
  const target = name === "" ? undefined : doc.components?.schemas?.[name];
  // An unresolvable ref is handed back as-is: it names the shape, which tells a
  // reader more than silently becoming null would.
  return target ?? schema;
};
