import type { Logger } from "../logging.js";
import { errorMessage } from "../errors.js";
import { compileEndpoint, type CompiledEndpoint, type OpenApiDocument } from "./schemaFromOpenApi.js";
import { ENDPOINTS } from "./endpoints.js";

export class SchemaRegistry {
  private compiled: Map<string, CompiledEndpoint>;

  private constructor(compiled: Map<string, CompiledEndpoint>) {
    this.compiled = compiled;
  }

  /**
   * Compiles every allowlisted entry against `doc`, throwing if any entry
   * fails. Used only at startup against the checked-in snapshot, which must
   * always compile cleanly — a failure here is a bug in this repo's own
   * allowlist, not a transient issue, so it should fail loudly.
   */
  static fromDocument(doc: OpenApiDocument): SchemaRegistry {
    const compiled = new Map<string, CompiledEndpoint>();
    for (const entry of ENDPOINTS) {
      compiled.set(entry.toolName, compileEndpoint(doc, entry));
    }
    return new SchemaRegistry(compiled);
  }

  get(toolName: string): CompiledEndpoint {
    const entry = this.compiled.get(toolName);
    if (!entry) throw new Error(`No compiled schema registered for tool "${toolName}"`);
    return entry;
  }

  list(): CompiledEndpoint[] {
    return [...this.compiled.values()];
  }

  /**
   * Recompiles every allowlisted entry against a freshly fetched `doc`. A
   * single entry's failure is logged and that entry keeps its last-known-good
   * schema; the rest still refresh — a removed or changed operation degrades
   * one tool, not the whole server.
   */
  refresh(doc: OpenApiDocument, logger: Logger): void {
    for (const entry of ENDPOINTS) {
      try {
        this.compiled.set(entry.toolName, compileEndpoint(doc, entry));
      } catch (err) {
        logger.error("openapi schema refresh failed for tool, keeping last-known-good", {
          tool: entry.toolName,
          error: errorMessage(err),
        });
      }
    }
  }
}
