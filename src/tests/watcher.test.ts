import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { listPlaceholders, placeholderForEvent, startWatcher } from "../core/watcher";
import { buildPlaceholderMeta, writePlaceholder } from "../core/placeholder";

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-watcher-"));
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

async function poll(predicate: () => boolean, timeoutMs = 8000, stepMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

describe("placeholderForEvent", () => {
  it("matches a path inside a placeholder", () => {
    const ph = path.join(root, "apps", "web");
    const event = path.join(ph, "src", "x.ts");
    expect(placeholderForEvent(event, [ph])).toBe(path.resolve(ph));
  });

  it("matches the placeholder dir itself", () => {
    const ph = path.join(root, "apps", "web");
    expect(placeholderForEvent(ph, [ph])).toBe(path.resolve(ph));
  });

  it("returns null when the path is outside every placeholder", () => {
    const ph = path.join(root, "apps", "web");
    expect(placeholderForEvent(path.join(root, "other", "y.ts"), [ph])).toBeNull();
  });

  it("does not match a sibling with a shared prefix", () => {
    const ph = path.join(root, "apps", "web");
    // "web-admin" shares the "web" prefix but is a different directory.
    expect(placeholderForEvent(path.join(root, "apps", "web-admin", "z.ts"), [ph])).toBeNull();
  });
});

describe("listPlaceholders", () => {
  it("returns only un-hydrated placeholders", async () => {
    await makePlaceholder("apps/web", "git@x:web.git");
    // A hydrated repo (has .git) is not a placeholder to watch.
    const hydrated = await makePlaceholder("apps/done", "git@x:done.git");
    await fs.mkdir(path.join(hydrated, ".git"), { recursive: true });
    // A plain folder.
    await fs.mkdir(path.join(root, "notes"), { recursive: true });

    const placeholders = await listPlaceholders(root);
    expect(placeholders).toEqual([path.resolve(root, "apps", "web")]);
  });
});

describe.skipIf(!GIT_OK)("startWatcher (integration)", () => {
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

  it("hydrates a placeholder when a file is written into it", async () => {
    const remote = await seedRemote("web");
    const dir = await makePlaceholder("apps/web", remote);

    let hydratedDir: string | null = null;
    const watcher = await startWatcher(
      root,
      { onHydrated: (d) => (hydratedDir = d) },
      { debounceMs: 100 },
    );

    expect(watcher.armed).toContain(path.resolve(dir));

    try {
      // Simulate a tool/editor touching the placeholder.
      await fs.writeFile(path.join(dir, "touch.tmp"), "x");

      const ok = await poll(() => existsSync(path.join(dir, ".git")));
      expect(ok).toBe(true);
      // Give the onHydrated callback a tick to fire.
      await poll(() => hydratedDir !== null, 1000);
      expect(hydratedDir).toBe(path.resolve(dir));
    } finally {
      await watcher.close();
    }
  });
});
