import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  FolderTransport,
  GitMapTransport,
  initFolderMap,
  loadTransport,
} from "../core/transport";
import { mapPaths, readWorkspaceMap, writeLinkConfig } from "../core/map";
import { readPlaceholder } from "../core/placeholder";
import { isGitRepo } from "../core/git";
import { linkCommand } from "../commands/link";
import { pullCommand } from "../commands/pull";
import { pushCommand } from "../commands/push";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-folder-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("FolderTransport", () => {
  it("pull mirrors the shared folder into the local map dir", async () => {
    const folder = path.join(root, "shared");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "workspace.json"), '{"v":1}');
    await fs.mkdir(path.join(folder, "machines"), { recursive: true });
    await fs.writeFile(path.join(folder, "machines", "a.json"), "{}");

    const mapDir = path.join(root, "map");
    await new FolderTransport(mapDir, folder).pull();

    expect(await fs.readFile(path.join(mapDir, "workspace.json"), "utf8")).toBe('{"v":1}');
    expect(existsSync(path.join(mapDir, "machines", "a.json"))).toBe(true);
  });

  it("refuses to pull iCloud stubs before pruning local map files", async () => {
    const folder = path.join(root, "shared");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "workspace.json.icloud"), "<plist></plist>");

    const mapDir = path.join(root, "map");
    await fs.mkdir(mapDir, { recursive: true });
    await fs.writeFile(path.join(mapDir, "workspace.json"), '{"real":true}');

    await expect(new FolderTransport(mapDir, folder).pull()).rejects.toThrow(/iCloud placeholder/);
    expect(await fs.readFile(path.join(mapDir, "workspace.json"), "utf8")).toBe('{"real":true}');
    expect(existsSync(path.join(mapDir, "workspace.json.icloud"))).toBe(false);
  });

  it("push mirrors the local map dir back and reports whether anything changed", async () => {
    const folder = path.join(root, "shared");
    const mapDir = path.join(root, "map");
    await fs.mkdir(mapDir, { recursive: true });
    await fs.writeFile(path.join(mapDir, "workspace.json"), "{}");

    const t = new FolderTransport(mapDir, folder);
    expect(await t.push("msg")).toBe(true); // first publish
    expect(existsSync(path.join(folder, "workspace.json"))).toBe(true);
    expect(await t.push("msg")).toBe(false); // nothing changed
  });

  it("refuses to push local iCloud stubs into the shared folder", async () => {
    const folder = path.join(root, "shared");
    const mapDir = path.join(root, "map");
    await fs.mkdir(mapDir, { recursive: true });
    await fs.writeFile(path.join(mapDir, "workspace.json.icloud"), "<plist></plist>");

    await expect(new FolderTransport(mapDir, folder).push("msg")).rejects.toThrow(
      /iCloud placeholder/,
    );
    expect(existsSync(path.join(folder, "workspace.json.icloud"))).toBe(false);
  });

  it("push prunes files deleted locally", async () => {
    const folder = path.join(root, "shared");
    const mapDir = path.join(root, "map");
    await fs.mkdir(mapDir, { recursive: true });
    await fs.writeFile(path.join(mapDir, "a.json"), "1");
    await fs.writeFile(path.join(mapDir, "b.json"), "2");

    const t = new FolderTransport(mapDir, folder);
    await t.push("seed");
    expect(existsSync(path.join(folder, "b.json"))).toBe(true);

    await fs.rm(path.join(mapDir, "b.json"));
    expect(await t.push("rm")).toBe(true);
    expect(existsSync(path.join(folder, "b.json"))).toBe(false);
  });
});

describe("initFolderMap", () => {
  it("seeds a new local map from an existing shared folder", async () => {
    const folder = path.join(root, "shared");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "workspace.json"), '{"seed":true}');

    const mapDir = path.join(root, "ws", ".boot", "map");
    const t = await initFolderMap(folder, mapDir);
    expect(t).toBeInstanceOf(FolderTransport);
    expect(await fs.readFile(path.join(mapDir, "workspace.json"), "utf8")).toBe('{"seed":true}');
  });

  it("refuses to clobber an existing map directory", async () => {
    const mapDir = path.join(root, "map");
    await fs.mkdir(mapDir, { recursive: true });
    await expect(initFolderMap(path.join(root, "shared"), mapDir)).rejects.toThrow(/already exists/);
  });
});

describe("loadTransport", () => {
  it("returns a FolderTransport when the workspace was linked to a folder", async () => {
    await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
    await writeLinkConfig(root, {
      kind: "folder",
      remote: path.join(root, "shared"),
      linkedAt: new Date().toISOString(),
    });
    expect(await loadTransport(root)).toBeInstanceOf(FolderTransport);
  });

  it("defaults to GitMapTransport (incl. legacy link files without a kind)", async () => {
    await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
    await writeLinkConfig(root, {
      kind: "git",
      remote: "git@example.com:x.git",
      linkedAt: new Date().toISOString(),
    });
    expect(await loadTransport(root)).toBeInstanceOf(GitMapTransport);
    // No link file at all → still git.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "boot-folder-x-"));
    try {
      expect(await loadTransport(other)).toBeInstanceOf(GitMapTransport);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Two-machine sync over a shared folder (no git remote for the map)   *
 * ------------------------------------------------------------------ */

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

describe.skipIf(!GIT_OK)("folder map sync across two machines (e2e)", () => {
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
    e2eRoot = await fs.mkdtemp(path.join(os.tmpdir(), "boot-folder-e2e-"));
    // The "Dropbox" folder — note: NOT a git repo.
    sharedFolder = path.join(e2eRoot, "dropbox", "boot-map");
    homeA = path.join(e2eRoot, "homeA");
    homeB = path.join(e2eRoot, "homeB");
    wsA = path.join(e2eRoot, "wsA");
    wsB = path.join(e2eRoot, "wsB");
    await makeRepo(e2eRoot, path.join(wsA, "apps", "api"), "api");
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(e2eRoot, { recursive: true, force: true });
  });

  it("links the first machine and writes the map into the shared folder", async () => {
    await asMachine(homeA, () => linkCommand(sharedFolder, wsA, { folder: true }));

    expect(existsSync(path.join(sharedFolder, "workspace.json"))).toBe(true);
    const map = await readWorkspaceMap(mapPaths(wsA).mapDir);
    expect(map?.repos.find((r) => r.relativePath === "apps/api")).toBeTruthy();
  });

  it("a second machine receives the structure as placeholders — no git remote involved", async () => {
    await asMachine(homeB, () => linkCommand(sharedFolder, wsB, { folder: true }));
    const repoDir = path.join(wsB, "apps", "api");
    expect(isGitRepo(repoDir)).toBe(false);
    expect((await readPlaceholder(repoDir))?.relativePath).toBe("apps/api");
  });

  it("propagates a new repo from B to A through the folder", async () => {
    await makeRepo(e2eRoot, path.join(wsB, "libs", "util"), "util");
    await asMachine(homeB, () => pushCommand(wsB));
    await asMachine(homeA, () => pullCommand(wsA));

    const meta = await readPlaceholder(path.join(wsA, "libs", "util"));
    expect(meta?.relativePath).toBe("libs/util");
  });
});
