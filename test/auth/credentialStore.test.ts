import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialStore, type StoredSession } from "../../src/auth/credentialStore.js";

const freshHome = (): string => mkdtempSync(join(tmpdir(), "hermes-cred-"));

const SESSION: StoredSession = {
  accessToken: "acc",
  refreshToken: "ref",
  expiresAt: 1790000000000,
  userId: "usr_1",
  storeId: "str_1",
  storeName: "SuperHero-vjro",
};

describe("CredentialStore", () => {
  it("reads null when nothing has been saved", () => {
    expect(new CredentialStore(freshHome()).read()).toBeNull();
  });

  it("round-trips a session", () => {
    const store = new CredentialStore(freshHome());
    store.save(SESSION);
    expect(store.read()).toEqual(SESSION);
  });

  it("creates the directory it needs", () => {
    const home = freshHome();
    new CredentialStore(home).save(SESSION);
    expect(statSync(join(home, ".hermes-mcp")).isDirectory()).toBe(true);
  });

  it("writes the file so only this user can read it", () => {
    const home = freshHome();
    const store = new CredentialStore(home);
    store.save(SESSION);

    if (process.platform === "win32") {
      // POSIX bits are a no-op on Windows — statSync reports group and world
      // read however the file was created — so the guarantee there is the ACL,
      // and the ACL is what gets asserted.
      const acl = execFileSync("icacls", [store.path], { encoding: "utf-8", windowsHide: true });
      expect(acl).not.toMatch(/BUILTIN\Users/i);
      expect(acl).not.toMatch(/Everyone/i);
      expect(acl).toContain(process.env.USERNAME ?? "");
    } else {
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    }
  });

  it("clears the stored session", () => {
    const store = new CredentialStore(freshHome());
    store.save(SESSION);
    store.clear();
    expect(store.read()).toBeNull();
  });

  it("clearing when nothing is stored is not an error", () => {
    expect(() => new CredentialStore(freshHome()).clear()).not.toThrow();
  });

  it("reads a corrupt file as 'not signed in' rather than throwing", () => {
    // A corrupt credentials file must never be a reason to refuse to work: the
    // remedy is to sign in again, which is exactly what "not signed in" causes.
    const home = freshHome();
    const store = new CredentialStore(home);
    store.save(SESSION);
    writeFileSync(store.path, "{not json at all");

    expect(store.read()).toBeNull();
  });

  it("reads a file missing required fields as 'not signed in'", () => {
    const home = freshHome();
    const store = new CredentialStore(home);
    store.save(SESSION);
    writeFileSync(store.path, JSON.stringify({ accessToken: "acc" }));

    expect(store.read()).toBeNull();
  });

  it("reports whether the file could be written", () => {
    const store = new CredentialStore(freshHome());
    expect(store.save(SESSION)).toBe(true);
  });

  it("survives an unwritable location by saying so rather than throwing", () => {
    // Login should still succeed for the running process; only persistence is
    // lost, and the caller needs to be able to say so.
    const home = freshHome();
    const store = new CredentialStore(home);
    store.save(SESSION);
    if (process.platform !== "win32") {
      chmodSync(join(home, ".hermes-mcp"), 0o500);
      expect(store.save({ ...SESSION, accessToken: "new" })).toBe(false);
      chmodSync(join(home, ".hermes-mcp"), 0o700);
    }
  });

  it("never writes a token into the directory name or path", () => {
    const store = new CredentialStore(freshHome());
    store.save(SESSION);
    expect(store.path).not.toContain("acc");
    expect(store.path).not.toContain("ref");
    expect(readFileSync(store.path, "utf-8")).toContain("acc");
  });
});
