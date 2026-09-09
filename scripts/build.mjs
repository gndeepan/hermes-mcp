import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts", "src/login.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir: "dist",
  external: ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio", "zod", "env-paths"],
  logLevel: "info",
});
