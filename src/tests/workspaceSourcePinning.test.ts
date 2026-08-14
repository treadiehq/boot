import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCurrentBranch,
  parseFullGitSha,
} from "../core/git";
import {
  emptyWorkspaceMap,
  mapPaths,
  readWorkspaceMap,
  writeWorkspaceMap,
} from "../core/map";
import { openWorkspaceSource } from "../core/workspaceSource";

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

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

async function mapHistory(root: string): Promise<{
  remote: string;
  first: string;
  latest: string;
}> {
  const author = path.join(root, "author");
  const remote = path.join(root, "map.git");
  await fs.mkdir(author, { recursive: true });
  git(author, "init", "-q", "-b", "main");
  git(author, "config", "user.email", "test@example.test");
  git(author, "config", "user.name", "tester");

  await writeWorkspaceMap(author, emptyWorkspaceMap("first"));
  git(author, "add", "-A");
  git(author, "commit", "-q", "-m", "first");
  const first = git(author, "rev-parse", "HEAD");

  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git(author, "remote", "add", "origin", remote);
  git(author, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], {
    stdio: "pipe",
  });

  const next = emptyWorkspaceMap("latest");
  await writeWorkspaceMap(author, next);
  git(author, "add", "-A");
  git(author, "commit", "-q", "-m", "latest");
  git(author, "push", "-q");
  return { remote, first, latest: git(author, "rev-parse", "HEAD") };
}

afterEach(async () => {
  while (roots.length > 0) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("full Git map SHA validation", () => {
  it("accepts exactly 40- and 64-character hexadecimal SHAs", () => {
    expect(parseFullGitSha("A".repeat(40))).toBe("a".repeat(40));
    expect(parseFullGitSha("B".repeat(64))).toBe("b".repeat(64));
  });

  it.each([
    "",
    "abc123",
    "g".repeat(40),
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
  ])("rejects %j", (value) => {
    expect(() => parseFullGitSha(value)).toThrow(
      "Map commit must be a full 40- or 64-character hexadecimal SHA.",
    );
  });
});

describe.skipIf(!gitUsable())("pinned workspace map sources", () => {
  it("uses an exact commit and lets the next normal pull recover from detached HEAD", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-source-pin-"));
    roots.push(root);
    const history = await mapHistory(root);
    const workspace = path.join(root, "workspace");

    const pinned = await openWorkspaceSource(history.remote, workspace, {
      mapCommit: history.first,
    });
    expect(pinned).toMatchObject({
      kind: "git",
      state: "linked",
      commit: history.first,
      pinned: true,
    });
    expect((await readWorkspaceMap(pinned.mapDir))?.workspace.name).toBe("first");
    expect(await getCurrentBranch(pinned.mapDir)).toBeNull();

    const updated = await openWorkspaceSource(history.remote, workspace);
    expect(updated).toMatchObject({
      kind: "git",
      state: "updated",
      commit: history.latest,
      pinned: false,
    });
    expect((await readWorkspaceMap(updated.mapDir))?.workspace.name).toBe("latest");
    expect(await getCurrentBranch(updated.mapDir)).toBe("main");
  });

  it("previews a pinned commit without touching the target workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-source-preview-pin-"));
    roots.push(root);
    const history = await mapHistory(root);
    const workspace = path.join(root, "workspace");

    const source = await openWorkspaceSource(history.remote, workspace, {
      dryRun: true,
      mapCommit: history.first,
    });
    expect(source).toMatchObject({
      state: "preview",
      commit: history.first,
      pinned: true,
    });
    expect((await readWorkspaceMap(source.mapDir))?.workspace.name).toBe("first");
    expect(existsSync(mapPaths(workspace).bootDir)).toBe(false);

    const previewRoot = source.inspectionRoot;
    await source.cleanup();
    expect(existsSync(previewRoot)).toBe(false);
  });

  it("refuses to pin a map with local changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-source-dirty-pin-"));
    roots.push(root);
    const history = await mapHistory(root);
    const workspace = path.join(root, "workspace");
    const linked = await openWorkspaceSource(history.remote, workspace);
    await fs.writeFile(path.join(linked.mapDir, "local-change.txt"), "keep me\n");

    await expect(
      openWorkspaceSource(history.remote, workspace, {
        mapCommit: history.first,
      }),
    ).rejects.toThrow(/working tree has local changes/i);

    expect(await fs.readFile(path.join(linked.mapDir, "local-change.txt"), "utf8"))
      .toBe("keep me\n");
  });
});
