import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { linkCommand } from "../commands/link";
import { pullCommand } from "../commands/pull";
import { pushCommand } from "../commands/push";
import { isGitRepo } from "../core/git";
import { isPlaceholder } from "../core/placeholder";

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

async function makeRepo(r: string, dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "tester");
  await fs.writeFile(path.join(dir, "package.json"), `{"name":"${name}"}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const remote = path.join(r, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "pipe" });
}

describe.skipIf(!GIT_OK)("pull --dry-run (e2e)", () => {
  let e2eRoot: string;
  let sharedFolder: string;
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
    e2eRoot = await fs.mkdtemp(path.join(os.tmpdir(), "boot-dryrun-"));
    sharedFolder = path.join(e2eRoot, "dropbox", "boot-map");
    homeA = path.join(e2eRoot, "homeA");
    homeB = path.join(e2eRoot, "homeB");
    wsA = path.join(e2eRoot, "wsA");
    wsB = path.join(e2eRoot, "wsB");
    await makeRepo(e2eRoot, path.join(wsA, "apps", "api"), "api");
    await asMachine(homeA, () => linkCommand(sharedFolder, wsA, { folder: true }));
    await asMachine(homeB, () => linkCommand(sharedFolder, wsB, { folder: true }));
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(e2eRoot, { recursive: true, force: true });
  });

  it("previews new structure without writing it, then applies on a real pull", async () => {
    // A publishes a brand-new repo.
    await makeRepo(e2eRoot, path.join(wsA, "libs", "util"), "util");
    await asMachine(homeA, () => pushCommand(wsA));

    const target = path.join(wsB, "libs", "util");

    // Dry run: B sees the plan but writes nothing.
    await asMachine(homeB, () => pullCommand(wsB, { dryRun: true }));
    expect(existsSync(target)).toBe(false);

    // Real pull: the placeholder appears.
    await asMachine(homeB, () => pullCommand(wsB));
    expect(isPlaceholder(target) || isGitRepo(target)).toBe(true);
  });
});
