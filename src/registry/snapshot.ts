import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OpenApiDocument } from "./schemaFromOpenApi.js";

/**
 * Walks up from `startDir` to the nearest ancestor containing a `package.json`.
 * Needed because esbuild bundles this module into a single file at `dist/`,
 * which sits one level shallower than `src/registry/` — a fixed `../..` would
 * be correct unbundled and wrong bundled. Walking to the package root works
 * at both depths.
 */
const findRepoRoot = (startDir: string): string => {
  let dir = startDir;
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find package.json above ${startDir}`);
    }
    dir = parent;
  }
  return dir;
};

export const loadSnapshotDoc = (): OpenApiDocument => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const snapshotPath = path.join(findRepoRoot(here), "openapi", "hermes-api-docs.json");
  return JSON.parse(readFileSync(snapshotPath, "utf-8")) as OpenApiDocument;
};
