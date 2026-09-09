#!/usr/bin/env node
import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import { createTokenStore } from "./auth/tokenStore.js";
import { startLoginServer } from "./login/loginServer.js";

const openBrowser = (url: string): void => {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {
    // A failure here is not fatal — the URL is printed for manual opening.
  });
};

const parseStoreFlag = (argv: string[]): string | undefined => {
  const index = argv.indexOf("--store");
  return index >= 0 ? argv[index + 1] : undefined;
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const server = await startLoginServer({
    hermesBaseUrl: config.hermesBaseUrl,
    store: createTokenStore(),
    presetStoreId: parseStoreFlag(process.argv.slice(2)),
  });

  const url = `http://127.0.0.1:${server.port}/`;
  process.stderr.write(`Opening ${url}\nIf your browser does not open, visit that URL.\n`);
  openBrowser(url);

  const ok = await server.waitForCompletion();
  await server.close();
  process.stderr.write(
    ok ? "Logged in. Credentials saved.\n" : "Login did not complete — the browser tab says why.\n"
  );
  process.exit(ok ? 0 : 1);
};

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
