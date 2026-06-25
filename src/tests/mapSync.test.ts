import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { linkCommand } from "../commands/link";
import { pushCommand } from "../commands/push";
import { pullCommand } from "../commands/pull";
import { isGitRepo } from "../core/git";
import { mapPaths, readWorkspaceMap } from "../core/map";
import { readPlaceholder } from "../core/placeholder";

/** Probe whether real git operations are possible (sandboxes sometimes forbid them). */
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

function bare(repoPath: string): void {
  execFileSync("git", ["init", "-q", "--bare", repoPath], { stdio: "pipe" });
}

/** Create a committed repo at `dir` wired to a fresh bare remote, returning the remote path. */
async function makeRepo(root: string, dir: string, name: string, branch = "main"): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "tester");
  await fs.writeFile(path.join(dir, "package.json"), `{"name":"${name}"}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const remote = path.join(root, `${name}.git`);
  bare(remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", branch);
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

describe.skipIf(!GIT_OK)("map sync: link → receive → push → pull across two machines", () => {
  let root: string;
  let mapRemote: string;
  let homeA: string;
  let homeB: string;
  let wsA: string;
  let wsB: string;
  let repoARemote: string;
  const prevHome = process.env.BOOT_HOME;

  /** Run an operation as a specific machine (its own BOOT_HOME = its own identity). */
  async function asMachine(home: string, fn: () => Promise<void>): Promise<string> {
    process.env.BOOT_HOME = home;
    try {
      return await capture(fn);
    } finally {
      process.env.BOOT_HOME = prevHome;
    }
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-sync-"));
    mapRemote = path.join(root, "map.git");
    bare(mapRemote);
    homeA = path.join(root, "homeA");
    homeB = path.join(root, "homeB");
    wsA = path.join(root, "wsA");
    wsB = path.join(root, "wsB");

    // Machine A already has a repo before it ever links.
    repoARemote = await makeRepo(root, path.join(wsA, "apps", "repo-a"), "repo-a");
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("link on the first machine publishes its existing repos to the map", async () => {
    await asMachine(homeA, () => linkCommand(mapRemote, wsA));

    const map = await readWorkspaceMap(mapPaths(wsA).mapDir);
    const repoA = map?.repos.find((r) => r.relativePath === "apps/repo-a");
    expect(repoA).toBeTruthy();
    expect(repoA?.remoteUrl).toBe(repoARemote);
    expect(repoA?.branch).toBe("main");
  });

  it("link on a fresh machine receives the structure as a hydratable placeholder", async () => {
    await asMachine(homeB, () => linkCommand(mapRemote, wsB));

    const repoDir = path.join(wsB, "apps", "repo-a");
    expect(isGitRepo(repoDir)).toBe(false);

    const meta = await readPlaceholder(repoDir);
    expect(meta?.hydrateStatus).toBe("placeholder");
    expect(meta?.remoteUrl).toBe(repoARemote);
  });

  it("records a separate state file per machine in the shared map", async () => {
    const machinesDir = path.join(mapPaths(wsB).mapDir, "machines");
    const files = readdirSync(machinesDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
  });

  it("a repo created on machine B propagates to machine A via push + pull", async () => {
    // B adds a brand-new repo and pushes the updated map.
    await makeRepo(root, path.join(wsB, "libs", "repo-b"), "repo-b");
    await asMachine(homeB, () => pushCommand(wsB));

    // A pulls and gets a placeholder for the new repo it has never seen.
    await asMachine(homeA, () => pullCommand(wsA));

    const repoBDir = path.join(wsA, "libs", "repo-b");
    expect(isGitRepo(repoBDir)).toBe(false);
    const meta = await readPlaceholder(repoBDir);
    expect(meta?.relativePath).toBe("libs/repo-b");
    expect(meta?.remoteUrl).toMatch(/repo-b\.git$/);
  });
});
