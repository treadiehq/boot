import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { cdCommand } from "../commands/cd";
import { buildPlaceholderMeta, writePlaceholder } from "../core/placeholder";
import { emptyWorkspaceMap, mapPaths, writeWorkspaceMap } from "../core/map";

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

let root: string;
let stdoutChunks: string[];
let stderrChunks: string[];

interface RepoSpec {
  name: string;
  relativePath: string;
  remoteUrl: string | null;
}

async function writeMap(repos: RepoSpec[]): Promise<void> {
  const map = emptyWorkspaceMap("test");
  map.repos = repos.map((repo) => ({
    name: repo.name,
    relativePath: repo.relativePath,
    remoteUrl: repo.remoteUrl,
    branch: "main",
    lastCommit: null,
    packageManager: null,
    projectType: "unknown",
  }));
  await writeWorkspaceMap(mapPaths(root).mapDir, map);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-cd-"));
  // Marking the map dir present makes the workspace "linked".
  await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
  await writeMap([
    { name: "web", relativePath: "apps/web", remoteUrl: "git@example.com:me/web.git" },
    { name: "api", relativePath: "services/api", remoteUrl: "git@example.com:me/api.git" },
    { name: "util", relativePath: "libs/util", remoteUrl: "git@example.com:me/util.git" },
  ]);
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function stdout(): string {
  return stdoutChunks.join("");
}

function stderr(): string {
  return stderrChunks.join("");
}

async function seedRemote(name: string): Promise<string> {
  const pub = path.join(root, `${name}-pub`);
  await fs.mkdir(pub, { recursive: true });
  git(pub, "init", "-q", "-b", "main");
  git(pub, "config", "user.email", "t@t.test");
  git(pub, "config", "user.name", "tester");
  await fs.writeFile(path.join(pub, "package.json"), "{}\n");
  git(pub, "add", "-A");
  git(pub, "commit", "-q", "-m", "init");
  const remote = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git(pub, "remote", "add", "origin", remote);
  git(pub, "push", "-q", "origin", "main");
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "pipe" });
  return remote;
}

async function makePlaceholder(rel: string, remoteUrl: string): Promise<string> {
  const repoDir = path.join(root, rel);
  await fs.mkdir(repoDir, { recursive: true });
  await writePlaceholder(
    repoDir,
    buildPlaceholderMeta({
      name: path.basename(rel),
      relativePath: rel,
      remoteUrl,
      currentBranch: "main",
      lastCommit: "abc123",
    }),
  );
  return repoDir;
}

describe("cdCommand (errors, no git needed)", () => {
  it("fails outside any linked workspace", async () => {
    const orphan = await fs.mkdtemp(path.join(os.tmpdir(), "boot-cd-orphan-"));
    try {
      await expect(cdCommand("web", { cwd: orphan, print: true })).rejects.toThrow(/boot link/);
    } finally {
      await fs.rm(orphan, { recursive: true, force: true });
    }
  });

  it("fails with an actionable message when nothing matches", async () => {
    await expect(cdCommand("zzz", { cwd: root, print: true })).rejects.toThrow(
      new Error(
        `No repository matches "zzz". Browse with \`boot cd -C ${root}\`, or list them with: boot status ${root}`,
      ),
    );
  });

  it("refuses an empty query when it cannot prompt", async () => {
    await expect(cdCommand("", { cwd: root, print: true })).rejects.toThrow(/Provide a repo/);
  });
});

describe.skipIf(!GIT_OK)("cdCommand (hydrating jump)", () => {
  it("prints the resolved path and hydrates a placeholder match", async () => {
    const remote = await seedRemote("web");
    const dir = await makePlaceholder("apps/web", remote);

    await cdCommand("web", { cwd: root, print: true });

    expect(stdout().trim()).toBe(dir);
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    expect(existsSync(path.join(dir, "package.json"))).toBe(true);
  });

  it("emits JSON with the hydrated flag", async () => {
    const remote = await seedRemote("api");
    await makePlaceholder("services/api", remote);

    await cdCommand("api", { cwd: root, json: true });

    const parsed = JSON.parse(stdout().trim());
    expect(parsed.relativePath).toBe("services/api");
    expect(parsed.hydrated).toBe(true);
    expect(parsed.path).toBe(path.join(root, "services/api"));
  });

  it("jumps to an already-real repo without re-cloning", async () => {
    // A real (non-placeholder) repo on disk: cd should just resolve its path.
    const dir = path.join(root, "apps/web");
    await fs.mkdir(dir, { recursive: true });
    git(dir, "init", "-q");

    await cdCommand("web", { cwd: root, json: true });

    const parsed = JSON.parse(stdout().trim());
    expect(parsed.path).toBe(dir);
    expect(parsed.hydrated).toBe(false);
  });

  it("reports no clone when revisiting a previously hydrated placeholder", async () => {
    const remote = await seedRemote("util");
    const dir = await makePlaceholder("libs/util", remote);

    await cdCommand("util", { cwd: root, json: true });
    expect(JSON.parse(stdout().trim()).hydrated).toBe(true);

    stdoutChunks = [];
    stderrChunks = [];
    await cdCommand("util", { cwd: root, json: true });

    const parsed = JSON.parse(stdout().trim());
    expect(parsed.path).toBe(dir);
    expect(parsed.hydrated).toBe(false);
    expect(stderr()).not.toContain("cloning");
  });
});
