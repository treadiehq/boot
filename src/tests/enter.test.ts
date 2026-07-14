import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { enterCommand } from "../commands/enter";
import { buildPlaceholderMeta, writePlaceholder } from "../core/placeholder";
import { mapPaths } from "../core/map";

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
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-enter-"));
  // Mark the workspace as linked so findWorkspaceRoot resolves it.
  await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  await fs.rm(root, { recursive: true, force: true });
});

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

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
}

describe.skipIf(!GIT_OK)("enterCommand", () => {
  it("hydrates the placeholder you navigate into", async () => {
    const remote = await seedRemote("web");
    const dir = await makePlaceholder("apps/web", remote);

    await enterCommand(path.join(dir, "src"));

    expect(existsSync(path.join(dir, "package.json"))).toBe(true);
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    expect(output()).toContain("cloned apps/web");
    expect(output()).toContain(path.join("apps", "web"));
  });

  it("prints nothing in quiet mode but still hydrates", async () => {
    const remote = await seedRemote("api");
    const dir = await makePlaceholder("services/api", remote);

    await enterCommand(dir, { quiet: true });

    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    expect(output()).toBe("");
  });

  it("reports that a plain folder is not a repository placeholder", async () => {
    const plain = path.join(root, "notes");
    await fs.mkdir(plain, { recursive: true });

    await enterCommand(plain);

    expect(output()).toContain("No repository placeholder found.");
  });
});
