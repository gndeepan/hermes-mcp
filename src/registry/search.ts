import type { OpenApiDocument, OpenApiParameter } from "./schemaFromOpenApi.js";
import { resolveRefOnce, type IndexedOperation, type OperationIndex } from "./operations.js";

export interface ParamDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ApiCandidate {
  method: string;
  path: string;
  summary: string;
  tags: string[];
  pathParams: ParamDoc[];
  queryParams: ParamDoc[];
  requestBody: unknown | null;
  responseSchema: unknown | null;
}

export interface SearchResult {
  candidates: ApiCandidate[];
  /** How many ranked matches were dropped to stay under the byte cap. */
  truncated: number;
}

/** 60 KB: room for ten hydrated operations, but not enough to swamp a context window. */
const DEFAULT_MAX_BYTES = 60_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

/**
 * Words that name an HTTP action rather than a thing.
 *
 * A query is almost always "<verb> <noun>", and scoring the verb as content is
 * actively harmful: "get user info" ranked `GET /api/v1/apps/{appId}/details/
 * app-info` first, because its summary "Get App Info" matched both "get" and
 * "info" while `/users/me` matched neither. The verb is a hint about which
 * method is wanted; it is not evidence about which resource.
 */
const VERBS: Record<string, string> = {
  get: "get",
  read: "get",
  list: "get",
  show: "get",
  fetch: "get",
  find: "get",
  view: "get",
  create: "post",
  add: "post",
  new: "post",
  update: "put",
  edit: "put",
  change: "put",
  set: "put",
  delete: "delete",
  remove: "delete",
};

/** Filler that survives verb-stripping but still says nothing about a resource. */
const STOPWORDS = new Set(["the", "for", "all", "any", "api", "endpoint", "call", "info", "data", "about"]);

/**
 * Crude singularisation, and crude is the right amount.
 *
 * Paths are plural nouns (`/users`, `/stores`) and questions are singular
 * ("get user info"). Without this, "user" misses `/users` entirely and loses to
 * any path with a literal `info` segment. A real stemmer would buy nothing
 * here: these are API path segments, not prose.
 */
const singular = (word: string): string =>
  word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

export interface ParsedQuery {
  tokens: string[];
  /** The method the query's verb implies, if it used one. A hint, never a filter. */
  hint?: string;
}

export const parseQuery = (query: string): ParsedQuery => {
  const raw = tokenize(query);
  const hint = raw.map((t) => VERBS[t]).find((m): m is string => m !== undefined);
  const content = raw.filter((t) => VERBS[t] === undefined && !STOPWORDS.has(t));
  // If the query was nothing but verbs and filler, score on what was said
  // rather than on nothing at all.
  return { tokens: (content.length > 0 ? content : raw).map(singular), ...(hint ? { hint } : {}) };
};

/**
 * Scores one operation against the query's tokens.
 *
 * The weights descend by how deliberately each field was written. A path
 * segment is the API's own noun and is almost always what a question is about;
 * a summary is written for a human; tags group loosely; descriptions are long
 * enough that one token matching inside them means very little. Exact segment
 * equality outranks a substring so "user" prefers `/users/{id}` over
 * `/store-users-report`.
 */
const score = (op: IndexedOperation, parsed: ParsedQuery): number => {
  const segments = op.path
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((s) => singular(s.replace(/[{}]/g, "")));
  const summary = tokenize(op.summary).map(singular);
  const tags = op.tags.map((t) => singular(t.toLowerCase()));
  const description = tokenize(op.description).map(singular);

  let total = 0;
  for (const token of parsed.tokens) {
    if (segments.includes(token)) total += 10;
    else if (segments.some((s) => s.includes(token))) total += 4;
    if (summary.includes(token)) total += 5;
    if (tags.some((t) => t.includes(token))) total += 2;
    if (description.includes(token)) total += 1;
  }
  // A hint, deliberately worth less than one segment match: a caller who says
  // "get" and means it should not outrank the right resource under a verb they
  // guessed wrong.
  if (total > 0 && parsed.hint !== undefined && op.method === parsed.hint) total += 3;
  if (total === 0) return 0;

  // Then subtract for what the query did not ask about. Two paths can match the
  // same noun equally and still differ in how much *else* they are about:
  // /users/{id} and /users/me both match "user", but "me" is a segment nobody
  // asked for, and it makes the operation narrower than the question. Counting
  // unexplained literal segments is what puts the general read ahead of the
  // alias without hard-coding either.
  //
  // Placeholders are not counted: `{id}` is not a topic, it is the hole the
  // caller fills. Nor is the version prefix, which every path carries.
  const unexplained = segments.filter(
    (seg, i) =>
      !(i === 0 && seg === "api") &&
      !/^v\d+$/.test(seg) &&
      !op.path.split("/").filter(Boolean)[i]?.startsWith("{") &&
      !parsed.tokens.some((t) => seg === t || seg.includes(t))
  ).length;

  return total - unexplained;
};

const paramDocs = (parameters: OpenApiParameter[], where: string): ParamDoc[] =>
  parameters
    .filter((p) => p.in === where)
    .map((p) => ({
      name: p.name,
      type: typeof p.schema?.type === "string" ? p.schema.type : "string",
      required: p.required === true,
      description: typeof p.description === "string" ? p.description : "",
    }));

const hydrate = (doc: OpenApiDocument, op: IndexedOperation): ApiCandidate => {
  const requestBody = op.operation.requestBody as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined;
  const responses = op.operation.responses as
    | Record<string, { content?: Record<string, { schema?: unknown }> }>
    | undefined;

  const bodySchema = requestBody?.content?.["application/json"]?.schema;
  const ok = responses?.["200"] ?? responses?.["201"];
  const responseSchema = ok?.content?.["application/json"]?.schema;

  return {
    method: op.method,
    path: op.path,
    summary: op.summary,
    tags: op.tags,
    pathParams: paramDocs(op.parameters, "path"),
    queryParams: paramDocs(op.parameters, "query"),
    requestBody: bodySchema === undefined ? null : resolveRefOnce(doc, bodySchema),
    responseSchema: responseSchema === undefined ? null : resolveRefOnce(doc, responseSchema),
  };
};

export const searchOperations = (
  index: OperationIndex,
  doc: OpenApiDocument,
  opts: { query: string; method?: string; limit?: number; maxBytes?: number }
): SearchResult => {
  const parsed = parseQuery(opts.query);
  const wanted = opts.method?.toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const ranked = index
    .all()
    .filter((op) => wanted === undefined || op.method === wanted)
    .map((op) => ({ op, points: score(op, parsed) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      // Ties: a read before a write, then the shorter path — the general
      // operation ahead of the special case.
      if (a.op.method !== b.op.method) {
        if (a.op.method === "get") return -1;
        if (b.op.method === "get") return 1;
      }
      return a.op.path.length - b.op.path.length;
    })
    .slice(0, limit);

  const candidates: ApiCandidate[] = [];
  let bytes = 0;
  for (const entry of ranked) {
    const candidate = hydrate(doc, entry.op);
    const size = JSON.stringify(candidate).length;
    // The first candidate goes in whatever it costs. An empty result reads as
    // "no such API", which is a wrong answer; an oversized single result is
    // merely an expensive right one.
    if (candidates.length > 0 && bytes + size > maxBytes) break;
    candidates.push(candidate);
    bytes += size;
  }

  return { candidates, truncated: ranked.length - candidates.length };
};
