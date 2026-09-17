import { build } from "esbuild";

await build({
  // Two entries, one codebase: stdio for a local single-user run and CI, HTTP
  // for the shared multi-merchant service. Both build the same server.
  entryPoints: ["src/server.ts", "src/httpServer.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  external: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio", "zod"],
  logLevel: "info",
});
