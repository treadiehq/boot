import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { autoHydrate, findWorkspaceRoot, nearestPlaceholder } from "../core/autohydrate";
import { buildPlaceholderMeta, isPlaceholder, writePlaceholder } from "../core/placeholder";
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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-autohydrate-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function makePlaceholder(rel: string, remoteUrl: string | null): Promise<string> {
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

/** A bare remote seeded with one commit on `main`. */
async function seedRemote(name: string): Promise<string> {
  const pub = path.join(root, `${name}-pub`);
  await fs.mkdir(pub, { recursive: true });
  git(pub, "init", "-q", "-b", "main");
  git(pub, "config", "user.email", "t@t.test");
  git(pub, "config", "user.name", "tester");
  await fs.writeFile(path.join(pub, "index.js"), "console.log('hi')\n");
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

describe("nearestPlaceholder", () => {
  it("returns the placeholder dir when the path is the placeholder itself", async () => {
    const dir = await makePlaceholder("apps/web", "git@x:web.git");
    expect(nearestPlaceholder(dir, root)).toBe(path.resolve(dir));
  });

  it("walks up from a nested path to the owning placeholder", async () => {
    const dir = await makePlaceholder("apps/web", "git@x:web.git");
    const nested = path.join(dir, "src", "deep", "file.ts");
    expect(nearestPlaceholder(nested, root)).toBe(path.resolve(dir));
  });

  it("returns null for a plain folder with no placeholder ancestor", async () => {
    const plain = path.join(root, "plain", "nested");
    await fs.mkdir(plain, { recursive: true });
    expect(nearestPlaceholder(plain, root)).toBeNull();
  });

  it("does not escape the stop boundary", async () => {
    const dir = await makePlaceholder("apps/web", "git@x:web.git");
    // Stop at apps/web itself; an unrelated sibling shouldn't resolve to it.
    const sibling = path.join(root, "apps", "other");
    await fs.mkdir(sibling, { recursive: true });
    expect(nearestPlaceholder(sibling, dir)).toBeNull();
  });
});

describe("findWorkspaceRoot", () => {
  it("finds the nearest linked workspace root", async () => {
    await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
    const nested = path.join(root, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(path.resolve(root));
  });

  it("returns null when not inside a linked workspace", async () => {
    const nested = path.join(root, "a", "b");
    await fs.mkdir(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBeNull();
  });
});

describe.skipIf(!GIT_OK)("autoHydrate (e2e)", () => {
  it("hydrates the placeholder owning a nested accessed path", async () => {
    const remote = await seedRemote("web");
    const dir = await makePlaceholder("apps/web", remote);

    const result = await autoHydrate(path.join(dir, "src", "thing.ts"), { stopAt: root });

    expect(result.hydrated).toBe(true);
    expect(result.repoDir).toBe(path.resolve(dir));
    // Real content materialised, .boot/ preserved.
    expect(existsSync(path.join(dir, "package.json"))).toBe(true);
    expect(existsSync(path.join(dir, ".git"))).toBe(true);
    expect(isPlaceholder(dir)).toBe(true);
  });

  it("is a no-op when there's nothing lazy at the path", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain, { recursive: true });
    const result = await autoHydrate(plain, { stopAt: root });
    expect(result.hydrated).toBe(false);
    expect(result.repoDir).toBeUndefined();
  });
});
