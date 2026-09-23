import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEnvFile, DEFAULT_ENV_FILE } from "../src/envFile.js";

/** A directory holding the named env files, so nothing here touches the repo's own `.env`. */
const withEnvFiles = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-envfile-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

/** Records what was asked for without touching the real `process.env`. */
const recordingLoader = (): { paths: string[]; load: (path: string) => void } => {
  const paths: string[] = [];
  return { paths, load: (path: string) => void paths.push(path) };
};

describe("applyEnvFile", () => {
  it("reads the default file for a single-user run", () => {
    const cwd = withEnvFiles({ [DEFAULT_ENV_FILE]: "HERMES_STORE_ID=str_1\n" });
    const loader = recordingLoader();

    const loaded = applyEnvFile({ env: { HERMES_SINGLE_USER: "1" }, cwd, loader: loader.load });

    expect(loaded).toBe(resolve(cwd, DEFAULT_ENV_FILE));
    expect(loader.paths).toEqual([resolve(cwd, DEFAULT_ENV_FILE)]);
  });

  it("reads nothing when the process is not single-user", () => {
    const cwd = withEnvFiles({ [DEFAULT_ENV_FILE]: "HERMES_STORE_ID=str_1\n" });
    const loader = recordingLoader();

    // The safety property: a shared process must not take its configuration
    // from a file that happens to sit in whatever directory it was spawned in.
    expect(applyEnvFile({ env: {}, cwd, loader: loader.load })).toBeNull();
    expect(applyEnvFile({ env: { HERMES_SINGLE_USER: "0" }, cwd, loader: loader.load })).toBeNull();
    expect(loader.paths).toEqual([]);
  });

  it("honours an explicit HERMES_ENV_FILE", () => {
    const cwd = withEnvFiles({ "local.env": "HERMES_STORE_ID=str_2\n" });
    const loader = recordingLoader();

    const loaded = applyEnvFile({
      env: { HERMES_SINGLE_USER: "1", HERMES_ENV_FILE: "local.env" },
      cwd,
      loader: loader.load,
    });

    expect(loaded).toBe(resolve(cwd, "local.env"));
  });

  it("treats an empty HERMES_ENV_FILE as 'read nothing'", () => {
    const cwd = withEnvFiles({ [DEFAULT_ENV_FILE]: "HERMES_STORE_ID=str_1\n" });
    const loader = recordingLoader();

    expect(
      applyEnvFile({ env: { HERMES_SINGLE_USER: "1", HERMES_ENV_FILE: "" }, cwd, loader: loader.load })
    ).toBeNull();
    expect(loader.paths).toEqual([]);
  });

  it("is silent about a file that is not there", () => {
    const cwd = withEnvFiles({});
    const loader = recordingLoader();

    // The path has a default, so most callers never chose it. Refusing to start
    // over the absence of a file nobody asked for would be a worse failure than
    // the MISSING_CREDENTIALS the caller gets instead.
    expect(applyEnvFile({ env: { HERMES_SINGLE_USER: "1" }, cwd, loader: loader.load })).toBeNull();
    expect(loader.paths).toEqual([]);
  });

  it("leaves a variable that is already set alone", () => {
    const cwd = withEnvFiles({ [DEFAULT_ENV_FILE]: "HERMES_STORE_ID=str_from_file\n" });
    const env: NodeJS.ProcessEnv = { HERMES_SINGLE_USER: "1", HERMES_STORE_ID: "str_from_shell" };

    // Node's loader does not overwrite, which is what makes a one-off
    // `HERMES_STORE_ID=… npx …` win over the file without editing it. Asserted
    // through the real loader, since this is that loader's behaviour.
    const before = process.env.HERMES_STORE_ID;
    try {
      process.env.HERMES_STORE_ID = "str_from_shell";
      applyEnvFile({ env: { ...env, HERMES_SINGLE_USER: "1" }, cwd });
      expect(process.env.HERMES_STORE_ID).toBe("str_from_shell");
    } finally {
      if (before === undefined) delete process.env.HERMES_STORE_ID;
      else process.env.HERMES_STORE_ID = before;
    }
  });
});
