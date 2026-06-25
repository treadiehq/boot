import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { linkCommand } from "../commands/link";
import { hydrateCommand } from "../commands/hydrate";
import { daemonStart, daemonStatus } from "../commands/daemon";
import { readDaemonState } from "../core/daemonState";
import { readPlaceholder } from "../core/placeholder";

function gitUsable(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(path.join(os.tmpdir(), "boot-gitprobe-"));
    execFileSync("git", ["init", "-q"], { cwd: probe, stdio: "pipe" });
    execFileSync("git", ["-C", probe, "config", "user.email", "probe@example.com"], {
      stdio: "pipe",
    });
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

function bare(p: string): void {
  execFileSync("git", ["init", "-q", "--bare", p], { stdio: "pipe" });
}

function head(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
}

async function makeRepo(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "tester");
  await fs.writeFile(path.join(dir, "file.txt"), "v1");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "v1");
  const remote = path.join(path.dirname(path.dirname(dir)), `${name}.git`);
  bare(remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  // Ensure the bare remote's default branch is `main` so a plain clone (used by
  // `boot hydrate`) checks it out rather than landing on a detached HEAD.
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "pipe" });
  return remote;
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    lines.push(String(m ?? ""));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe.skipIf(!GIT_OK)("daemon --once", () => {
  let root: string;
  let mapRemote: string;
  let homeA: string;
  let homeB: string;
  let wsA: string;
  let wsB: string;
  const prevHome = process.env.BOOT_HOME;

  async function asMachine(home: string, fn: () => Promise<void>): Promise<string> {
    process.env.BOOT_HOME = home;
    try {
      return await capture(fn);
    } finally {
      process.env.BOOT_HOME = prevHome;
    }
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-daemon-"));
    mapRemote = path.join(root, "map.git");
    bare(mapRemote);
    homeA = path.join(root, "homeA");
    homeB = path.join(root, "homeB");
    wsA = path.join(root, "wsA");
    wsB = path.join(root, "wsB");

    await makeRepo(path.join(wsA, "apps", "repo-a"), "repo-a");
    await asMachine(homeA, () => linkCommand(mapRemote, wsA));
    await asMachine(homeB, () => linkCommand(mapRemote, wsB));
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("runs a single sync, records its state, and leaves no live pid", async () => {
    await asMachine(homeB, () => daemonStart(wsB, { once: true }));

    const state = await readDaemonState(wsB);
    expect(state?.pid).toBeNull();
    expect(state?.lastTick?.ok).toBe(true);
    expect(state?.lastTick?.repoCount).toBeGreaterThanOrEqual(1);

    // The placeholder from link is already present, so this tick re-confirms it.
    const meta = await readPlaceholder(path.join(wsB, "apps", "repo-a"));
    expect(meta?.relativePath).toBe("apps/repo-a");
  });

  it("status reports the last sync and that the daemon is not running", async () => {
    const out = await asMachine(homeB, () => daemonStatus(wsB));
    expect(out).toMatch(/not running/);
    expect(out).toMatch(/Last sync:/);
  });

  it("fast-forwards a hydrated repo that fell behind its remote", async () => {
    // Hydrate repo-a on machine B so it becomes a real clone.
    const repoB = path.join(wsB, "apps", "repo-a");
    await asMachine(homeB, () => hydrateCommand(repoB));

    // Machine A advances repo-a's remote.
    const repoA = path.join(wsA, "apps", "repo-a");
    await fs.writeFile(path.join(repoA, "file.txt"), "v2");
    git(repoA, "add", "-A");
    git(repoA, "commit", "-q", "-m", "v2");
    git(repoA, "push", "-q", "origin", "main");
    const target = head(repoA);

    // The daemon tick on B should fetch and fast-forward repo-a to v2.
    await asMachine(homeB, () => daemonStart(wsB, { once: true }));

    expect(head(repoB)).toBe(target);
    const state = await readDaemonState(wsB);
    expect(state?.lastTick?.updated).toBeGreaterThanOrEqual(1);
  });
});
