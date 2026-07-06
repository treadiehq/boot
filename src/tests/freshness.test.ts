import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { runFreshness } from "../core/freshness";
import { scanWorkspace } from "../core/scanner";
import { buildPlaceholderMeta, writePlaceholder } from "../core/placeholder";

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

function head(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
}

function clone(remote: string, dest: string, branch = "main"): void {
  execFileSync("git", ["clone", "-q", "-b", branch, remote, dest], { stdio: "pipe" });
}

function configIdentity(dir: string): void {
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "tester");
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-fresh-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Create a bare remote seeded with one commit on `branch`, plus a "publisher"
 * working clone we can use to push later commits. Returns both paths.
 */
async function seedRemote(name: string, branch = "main"): Promise<{ remote: string; publisher: string }> {
  const publisher = path.join(root, `${name}-pub`);
  await fs.mkdir(publisher, { recursive: true });
  git(publisher, "init", "-q", "-b", branch);
  configIdentity(publisher);
  await fs.writeFile(path.join(publisher, "file.txt"), "v1");
  git(publisher, "add", "-A");
  git(publisher, "commit", "-q", "-m", "v1");
  const remote = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git(publisher, "remote", "add", "origin", remote);
  git(publisher, "push", "-q", "origin", branch);
  // Make the bare remote's default branch match what we pushed so plain clones
  // (and production hydrate) check it out instead of landing detached.
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", `refs/heads/${branch}`], {
    stdio: "pipe",
  });
  return { remote, publisher };
}

async function publishCommit(publisher: string, branch = "main"): Promise<string> {
  await fs.writeFile(path.join(publisher, "file.txt"), `v-${Date.now()}`);
  git(publisher, "add", "-A");
  git(publisher, "commit", "-q", "-m", "next");
  git(publisher, "push", "-q", "origin", branch);
  return head(publisher);
}

describe.skipIf(!GIT_OK)("runFreshness", () => {
  it("fast-forwards a clean default-branch repo that fell behind", async () => {
    const { remote, publisher } = await seedRemote("app");
    const repoDir = path.join(root, "ws", "app");
    clone(remote, repoDir);

    const scan = await scanWorkspace(path.join(root, "ws"));
    const newSha = await publishCommit(publisher);

    const report = await runFreshness(scan.repos, { fastForward: true });
    const app = report.repos.find((r) => r.relativePath === "app");

    expect(app?.status).toBe("updated");
    expect(head(repoDir)).toBe(newSha);
    expect(report.counts.updated).toBe(1);
  });

  it("reports up-to-date when nothing changed", async () => {
    const { remote } = await seedRemote("app");
    const repoDir = path.join(root, "ws", "app");
    clone(remote, repoDir);

    const scan = await scanWorkspace(path.join(root, "ws"));
    const report = await runFreshness(scan.repos, { fastForward: true });

    expect(report.repos[0]?.status).toBe("up-to-date");
  });

  it("reports fetch-failed instead of up-to-date when upstream refs cannot refresh", async () => {
    const { remote } = await seedRemote("app");
    const repoDir = path.join(root, "ws", "app");
    clone(remote, repoDir);
    git(repoDir, "remote", "set-url", "origin", path.join(root, "missing.git"));

    const scan = await scanWorkspace(path.join(root, "ws"));
    const report = await runFreshness(scan.repos, { fastForward: true });

    expect(report.repos[0]?.status).toBe("fetch-failed");
    expect(report.counts["fetch-failed"]).toBe(1);
    expect(report.counts["up-to-date"]).toBe(0);
  });

  it("never touches a dirty repo, even when behind", async () => {
    const { remote, publisher } = await seedRemote("app");
    const repoDir = path.join(root, "ws", "app");
    clone(remote, repoDir);
    const before = head(repoDir);

    const scan = await scanWorkspace(path.join(root, "ws"));
    await publishCommit(publisher);
    await fs.writeFile(path.join(repoDir, "dirty.txt"), "uncommitted");

    const report = await runFreshness(scan.repos, { fastForward: true });
    const app = report.repos.find((r) => r.relativePath === "app");

    expect(app?.status).toBe("dirty");
    expect(head(repoDir)).toBe(before);
  });

  it("does not auto-advance a non-default branch", async () => {
    const { remote, publisher } = await seedRemote("app", "feature");
    const repoDir = path.join(root, "ws", "app");
    clone(remote, repoDir, "feature");
    const before = head(repoDir);

    const scan = await scanWorkspace(path.join(root, "ws"));
    await publishCommit(publisher, "feature");

    const report = await runFreshness(scan.repos, {
      fastForward: true,
      defaultBranchNames: ["main", "master"],
    });
    const app = report.repos.find((r) => r.relativePath === "app");

    expect(app?.status).toBe("behind");
    expect(head(repoDir)).toBe(before);
  });

  it("classifies a repo with no upstream and a placeholder", async () => {
    // A repo with commits but no remote/upstream.
    const noRemote = path.join(root, "ws", "local-only");
    await fs.mkdir(noRemote, { recursive: true });
    git(noRemote, "init", "-q", "-b", "main");
    configIdentity(noRemote);
    await fs.writeFile(path.join(noRemote, "x.txt"), "x");
    git(noRemote, "add", "-A");
    git(noRemote, "commit", "-q", "-m", "init");

    // A placeholder that has not been hydrated.
    const ph = path.join(root, "ws", "ph");
    await fs.mkdir(ph, { recursive: true });
    await writePlaceholder(
      ph,
      buildPlaceholderMeta({
        name: "ph",
        relativePath: "ph",
        remoteUrl: "git@example.com:ph.git",
        currentBranch: "main",
        lastCommit: "abc",
      }),
    );

    const scan = await scanWorkspace(path.join(root, "ws"));
    const report = await runFreshness(scan.repos, { fastForward: true });

    expect(report.repos.find((r) => r.relativePath === "local-only")?.status).toBe("no-upstream");
    expect(report.repos.find((r) => r.relativePath === "ph")?.status).toBe("placeholder");
  });
});
