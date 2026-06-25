import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { initCommand } from "../commands/init";
import { scanCommand } from "../commands/scan";
import { listCommand } from "../commands/list";
import { restoreCommand } from "../commands/restore";
import { statusCommand } from "../commands/status";
import { hydrateCommand } from "../commands/hydrate";
import { doctorCommand } from "../commands/doctor";
import { readManifest } from "../core/manifest";
import { readPlaceholder } from "../core/placeholder";
import { IGNORE_FILE_NAME } from "../core/ignore";
import { CONFIG_FILE_NAME } from "../core/config";

/**
 * Probe whether real git operations are possible in this environment. Sandboxed
 * CI/agent runners often forbid git writing `.git/config`; when that happens we
 * skip the network-free E2E rather than fail. It still runs on developer
 * machines and normal CI.
 */
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

describe.skipIf(!GIT_OK)("E2E: init → scan → list → lazy restore → status → hydrate → doctor", () => {
  let root: string;
  let ws: string;
  let bareRemote: string;
  let manifestPath: string;
  let restorePath: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-e2e-"));
    ws = path.join(root, "ws");
    bareRemote = path.join(root, "remote-a.git");
    manifestPath = path.join(root, "manifest.json");
    restorePath = path.join(root, "restored");
    await fs.mkdir(ws, { recursive: true });

    // repo-a: node project with a real remote (local bare repo), clean, on main.
    const repoA = path.join(ws, "apps", "repo-a");
    await fs.mkdir(repoA, { recursive: true });
    git(repoA, "init", "-q", "-b", "main");
    git(repoA, "config", "user.email", "t@t.test");
    git(repoA, "config", "user.name", "tester");
    await fs.writeFile(path.join(repoA, "package.json"), '{"name":"repo-a"}');
    await fs.writeFile(path.join(repoA, "pnpm-lock.yaml"), "");
    git(repoA, "add", "-A");
    git(repoA, "commit", "-q", "-m", "init");
    execFileSync("git", ["init", "-q", "--bare", bareRemote], { stdio: "pipe" });
    git(repoA, "remote", "add", "origin", bareRemote);
    git(repoA, "push", "-q", "origin", "main");

    // repo-b: no remote, dirty, on a feature branch.
    const repoB = path.join(ws, "old", "repo-b");
    await fs.mkdir(repoB, { recursive: true });
    git(repoB, "init", "-q", "-b", "feature");
    git(repoB, "config", "user.email", "t@t.test");
    git(repoB, "config", "user.name", "tester");
    await fs.writeFile(path.join(repoB, "main.go"), "package main");
    git(repoB, "add", "-A");
    git(repoB, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(repoB, "uncommitted.txt"), "dirty");

    // A generated folder containing a (fake) repo that must be ignored.
    await fs.mkdir(path.join(ws, "node_modules", "ghost", ".git"), { recursive: true });
    // A plain folder with no repo or placeholder.
    await fs.mkdir(path.join(ws, "scratch"), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("init creates the ignore + config files", async () => {
    await capture(() => initCommand(ws));
    await expect(fs.stat(path.join(ws, IGNORE_FILE_NAME))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(ws, CONFIG_FILE_NAME))).resolves.toBeTruthy();
  });

  it("scan writes a valid 0.2 manifest with config and repo data", async () => {
    await capture(() => scanCommand(ws, { output: manifestPath }));
    const manifest = await readManifest(manifestPath);

    expect(manifest.version).toBe("0.2");
    expect(manifest.config.defaultIgnoreRules.length).toBeGreaterThan(0);
    expect(manifest.config.ignoreFiles.some((f) => f.scope === "workspace")).toBe(true);

    const rels = manifest.repos.map((r) => r.relativePath).sort();
    expect(rels).toEqual(["apps/repo-a", "old/repo-b"]);
    // The repo hidden inside node_modules must NOT be discovered.
    expect(rels).not.toContain("node_modules/ghost");

    const repoA = manifest.repos.find((r) => r.relativePath === "apps/repo-a")!;
    expect(repoA.remoteUrl).toBe(bareRemote);
    expect(repoA.currentBranch).toBe("main");
    expect(repoA.dirty).toBe(false);
    expect(repoA.projectType).toBe("node");
    expect(repoA.packageManager).toBe("pnpm");
    expect(repoA.lastCommit).toMatch(/^[0-9a-f]{40}$/);

    const repoB = manifest.repos.find((r) => r.relativePath === "old/repo-b")!;
    expect(repoB.remoteUrl).toBeNull();
    expect(repoB.dirty).toBe(true);
    expect(repoB.currentBranch).toBe("feature");
  });

  it("list prints both repos", async () => {
    const out = await capture(() => listCommand(manifestPath));
    expect(out).toContain("repo-a");
    expect(out).toContain("repo-b");
  });

  it("lazy restore creates placeholders without cloning", async () => {
    const out = await capture(() => restoreCommand(manifestPath, restorePath, { lazy: true }));
    expect(out).toMatch(/Lazy restore complete/);

    const metaA = await readPlaceholder(path.join(restorePath, "apps/repo-a"));
    expect(metaA?.hydrateStatus).toBe("placeholder");
    expect(metaA?.remoteUrl).toBe(bareRemote);

    const metaB = await readPlaceholder(path.join(restorePath, "old/repo-b"));
    expect(metaB?.remoteUrl).toBeNull();

    // No clone yet.
    await expect(fs.stat(path.join(restorePath, "apps/repo-a", ".git"))).rejects.toBeTruthy();
  });

  it("status shows placeholders before hydration", async () => {
    const out = await capture(() => statusCommand(restorePath));
    expect(out).toContain("Placeholders:");
    expect(out).toContain("apps/repo-a");
    expect(out).toContain("old/repo-b");
    expect(out).toContain("Placeholders: 2");
  });

  it("hydrate clones a placeholder and marks it hydrated", async () => {
    const repoDir = path.join(restorePath, "apps/repo-a");
    const out = await capture(() => hydrateCommand(repoDir));
    expect(out).toMatch(/hydrating/);
    expect(out).toMatch(/start working/);

    await expect(fs.stat(path.join(repoDir, ".git"))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(repoDir, "package.json"), "utf8")).resolves.toContain(
      "repo-a",
    );

    const meta = await readPlaceholder(repoDir);
    expect(meta?.hydrateStatus).toBe("hydrated");

    // The hydrated repo is clean (no untracked .boot noise).
    const porcelain = execFileSync("git", ["-C", repoDir, "status", "--porcelain"]).toString();
    expect(porcelain.trim()).toBe("");
  });

  it("status reflects the hydrated repo afterwards", async () => {
    const out = await capture(() => statusCommand(restorePath));
    expect(out).toContain("Hydrated:");
    expect(out).toContain("apps/repo-a");
    expect(out).toContain("Hydrated repos: 1");
    expect(out).toContain("Placeholders: 1");
  });

  it("doctor reports useful warnings", async () => {
    const out = await capture(() => doctorCommand(restorePath));
    expect(out).toMatch(/Doctor/);
    expect(out).toContain(`workspace has no ${IGNORE_FILE_NAME}`);
    expect(out).toMatch(/old\/repo-b is a placeholder with no remote URL/);
  });
});
