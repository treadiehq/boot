import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseDotenv, serializeDotenv } from "../core/env";
import { exportKeyBase64 } from "../core/secrets";
import { linkCommand } from "../commands/link";
import { envImport, envInit, envKeyImport, envList, envMaterialize, envRm, envSet } from "../commands/env";

function gitUsable(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(path.join(os.tmpdir(), "boot-gitprobe-"));
    execFileSync("git", ["init", "-q"], { cwd: probe, stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

const GIT_OK = gitUsable();

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function bare(repoPath: string): void {
  execFileSync("git", ["init", "-q", "--bare", repoPath], { stdio: "pipe" });
}

async function makeRepo(root: string, dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "tester");
  await fs.writeFile(path.join(dir, "package.json"), `{"name":"${name}"}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const remote = path.join(root, `${name}.git`);
  bare(remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "pipe" });
  return remote;
}

describe("parseDotenv", () => {
  it("parses pairs, ignores comments/blanks, strips quotes and export", () => {
    const vars = parseDotenv(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "export EXPORTED=yes",
        'QUOTED="has spaces"',
        "SINGLE='single quoted'",
        "WITH_EQ=a=b=c",
        'ESCAPED="line1\\nline2"',
      ].join("\n"),
    );
    expect(vars).toEqual({
      PLAIN: "value",
      EXPORTED: "yes",
      QUOTED: "has spaces",
      SINGLE: "single quoted",
      WITH_EQ: "a=b=c",
      ESCAPED: "line1\nline2",
    });
  });
});

describe("serializeDotenv", () => {
  it("sorts keys and quotes values that need it", () => {
    const text = serializeDotenv({ B: "plain", A: "has spaces", C: "" });
    expect(text).toBe('A="has spaces"\nB=plain\nC=""\n');
  });

  it("round-trips through parseDotenv", () => {
    const original = { TOKEN: "abc123", URL: "https://x.test/path?a=b", NOTE: "a b c" };
    expect(parseDotenv(serializeDotenv(original))).toEqual(original);
  });
});

describe.skipIf(!GIT_OK)("env sync across machines (e2e)", () => {
  let root: string;
  let mapRemote: string;
  let homeA: string;
  let homeB: string;
  let wsA: string;
  let wsB: string;
  const prevHome = process.env.BOOT_HOME;

  async function asMachine(home: string, fn: () => Promise<void>): Promise<void> {
    process.env.BOOT_HOME = home;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fn();
    } finally {
      spy.mockRestore();
      process.env.BOOT_HOME = prevHome;
    }
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-env-"));
    mapRemote = path.join(root, "map.git");
    bare(mapRemote);
    homeA = path.join(root, "homeA");
    homeB = path.join(root, "homeB");
    wsA = path.join(root, "wsA");
    wsB = path.join(root, "wsB");
    await makeRepo(root, path.join(wsA, "apps", "api"), "api");
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("sets, lists, and materializes env vars on the authoring machine", async () => {
    await asMachine(homeA, () => linkCommand(mapRemote, wsA));
    await asMachine(homeA, () => envInit());
    await asMachine(homeA, () => envSet(["API_KEY=secret123", "DB_URL=postgres://x"], { cwd: wsA }));
    await asMachine(homeA, () => envSet(["TOKEN=abc"], { cwd: wsA, repo: "apps/api" }));

    // List shows the keys but never the plaintext values.
    let listed = "";
    process.env.BOOT_HOME = homeA;
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      listed += `${String(m ?? "")}\n`;
    });
    try {
      await envList({ cwd: wsA });
    } finally {
      spy.mockRestore();
      process.env.BOOT_HOME = prevHome;
    }
    expect(listed).toMatch(/API_KEY/);
    expect(listed).not.toMatch(/secret123/);

    await asMachine(homeA, () => envMaterialize({ cwd: wsA }));

    const globalEnv = parseDotenv(await fs.readFile(path.join(wsA, ".env"), "utf8"));
    expect(globalEnv.API_KEY).toBe("secret123");
    const repoEnv = parseDotenv(await fs.readFile(path.join(wsA, "apps", "api", ".env"), "utf8"));
    expect(repoEnv.TOKEN).toBe("abc");

    // The repo's .env is git-excluded so it can't be committed by accident.
    const exclude = await fs.readFile(path.join(wsA, "apps", "api", ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".env");
  });

  it("a second machine needs the key, then materializes identical secrets", async () => {
    await asMachine(homeB, () => linkCommand(mapRemote, wsB));

    // Without the key, materialize fails with a clear message.
    process.env.BOOT_HOME = homeB;
    try {
      await expect(envMaterialize({ cwd: wsB })).rejects.toThrow(/No boot secret key/);
    } finally {
      process.env.BOOT_HOME = prevHome;
    }

    // Copy the key from A to B, then it works.
    process.env.BOOT_HOME = homeA;
    const exported = await exportKeyBase64();
    process.env.BOOT_HOME = prevHome;

    await asMachine(homeB, () => envKeyImport(exported));
    await asMachine(homeB, () => envMaterialize({ cwd: wsB }));

    const globalEnv = parseDotenv(await fs.readFile(path.join(wsB, ".env"), "utf8"));
    expect(globalEnv.API_KEY).toBe("secret123");
    expect(globalEnv.DB_URL).toBe("postgres://x");
    // apps/api is a placeholder on B, but its .env still materialised.
    const repoEnv = parseDotenv(await fs.readFile(path.join(wsB, "apps", "api", ".env"), "utf8"));
    expect(repoEnv.TOKEN).toBe("abc");
  });

  it("import merges and rm deletes keys, propagating across machines", async () => {
    const extra = path.join(root, "extra.env");
    await fs.writeFile(extra, "EXTRA=1\nAPI_KEY=overwritten\n");
    await asMachine(homeA, () => envImport(extra, { cwd: wsA }));
    await asMachine(homeA, () => envRm(["DB_URL"], { cwd: wsA }));

    await asMachine(homeB, () => envMaterialize({ cwd: wsB }));
    const globalEnv = parseDotenv(await fs.readFile(path.join(wsB, ".env"), "utf8"));
    expect(globalEnv.EXTRA).toBe("1");
    expect(globalEnv.API_KEY).toBe("overwritten");
    expect(globalEnv.DB_URL).toBeUndefined();
  });
});
