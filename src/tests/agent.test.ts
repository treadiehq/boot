import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { agentCommand } from "../commands/agent";
import { envInit, envKeyImport, envSet } from "../commands/env";
import { linkCommand } from "../commands/link";
import { exportKeyBase64 } from "../core/secrets";
import { isGitRepo } from "../core/git";
import { isLinked } from "../core/map";
import { parseDotenv } from "../core/env";
import { readPlaceholder } from "../core/placeholder";

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

describe.skipIf(!GIT_OK)("agent bootstrap (e2e)", () => {
  let root: string;
  let mapRemote: string;
  let homeA: string;
  let homeC: string;
  let wsA: string;
  let wsC: string;
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-agent-"));
    mapRemote = path.join(root, "map.git");
    bare(mapRemote);
    homeA = path.join(root, "homeA");
    homeC = path.join(root, "homeC");
    wsA = path.join(root, "wsA");
    wsC = path.join(root, "wsC");

    // Authoring machine seeds the map with a repo + an env var.
    await makeRepo(root, path.join(wsA, "apps", "api"), "api");
    await asMachine(homeA, () => linkCommand(mapRemote, wsA));
    await asMachine(homeA, () => envInit());
    await asMachine(homeA, () => envSet(["API_KEY=secret123"], { cwd: wsA }));
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("bootstraps a fresh environment into placeholders", async () => {
    await asMachine(homeC, () => agentCommand(mapRemote, wsC));

    expect(isLinked(wsC)).toBe(true);
    const repoDir = path.join(wsC, "apps", "api");
    expect(isGitRepo(repoDir)).toBe(false);
    const meta = await readPlaceholder(repoDir);
    expect(meta?.remoteUrl).toMatch(/api\.git$/);
  });

  it("is idempotent — a second run just pulls", async () => {
    await expect(asMachine(homeC, () => agentCommand(mapRemote, wsC))).resolves.toBeUndefined();
    expect(isLinked(wsC)).toBe(true);
  });

  it("hydrates placeholders matching a pattern", async () => {
    await asMachine(homeC, () => agentCommand(mapRemote, wsC, { hydrate: ["apps/*"] }));
    expect(isGitRepo(path.join(wsC, "apps", "api"))).toBe(true);
  });

  it("skips env without a key, then materializes once the key is present", async () => {
    // No key on machine C yet → best-effort skip, no throw.
    await expect(
      asMachine(homeC, () => agentCommand(mapRemote, wsC, { env: true })),
    ).resolves.toBeUndefined();

    // Bring the key over and re-run with --env.
    process.env.BOOT_HOME = homeA;
    const exported = await exportKeyBase64();
    process.env.BOOT_HOME = prevHome;
    await asMachine(homeC, () => envKeyImport(exported));
    await asMachine(homeC, () => agentCommand(mapRemote, wsC, { env: true }));

    const env = parseDotenv(await fs.readFile(path.join(wsC, ".env"), "utf8"));
    expect(env.API_KEY).toBe("secret123");
  });
});
