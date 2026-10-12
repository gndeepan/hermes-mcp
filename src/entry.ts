import { realpathSync } from "node:fs";
import { basename } from "node:path";

/**
 * Whether this process was started as `file` (e.g. `server.js`).
 *
 * The script path is resolved first, because npm and npx never start a bin by
 * its own name: they run `node_modules/.bin/hermes-mcp`, a symlink to
 * `dist/server.js`. Checking the unresolved path for `server.js` made every
 * `npx` install start, print nothing and wait — a server that never served.
 *
 * Compared by file name, not by `import.meta.url`: `httpServer.js` bundles
 * `server.ts` too, so both entry blocks share one module URL in that bundle.
 */
export const invokedAs = (file: string, scriptPath: string | undefined = process.argv[1]): boolean => {
  if (!scriptPath) return false;
  try {
    return basename(realpathSync(scriptPath)) === file;
  } catch {
    return false;
  }
};
