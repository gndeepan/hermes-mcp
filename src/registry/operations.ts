import type {
  HttpMethod,
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
} from "./schemaFromOpenApi.js";

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
