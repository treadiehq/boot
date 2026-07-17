import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanWorkspace } from "../core/scanner";
import { buildPlaceholderMeta, writePlaceholder } from "../core/placeholder";
import { IGNORE_FILE_NAME } from "../core/ignore";
import { CONFIG_FILE_NAME } from "../core/config";

let root: string;

async function mkdir(rel: string): Promise<void> {
  await fs.mkdir(path.join(root, rel), { recursive: true });
}

async function touch(rel: string, contents = ""): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-scan-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("scanWorkspace", () => {
  it("finds git repos and ignores generated/nested directories", async () => {
    await mkdir("apps/web/.git");
    await touch("apps/web/package.json", "{}");
    await mkdir("libs/util/.git");

    // A repo nested inside another repo must NOT be discovered separately.
    await mkdir("apps/web/node_modules/dep/.git");
    // A repo inside a top-level skipped dir must NOT be discovered.
    await mkdir("node_modules/ghost/.git");
    await mkdir(".cache/cached/.git");
    await touch("docs/readme.md", "hello");

    const result = await scanWorkspace(root);
    const rels = result.repos.map((r) => r.relativePath).sort();

    expect(rels).toEqual(["apps/web", "libs/util"]);
    expect(result.rootName).toBe(path.basename(root));
  });

  it("uses portable posix relative paths and basename for repo name", async () => {
    await mkdir("group/nested/project/.git");

    const result = await scanWorkspace(root);
    expect(result.repos).toHaveLength(1);

    const repo = result.repos[0]!;
    expect(repo.relativePath).toBe("group/nested/project");
    expect(repo.relativePath).not.toContain("\\");
    expect(repo.name).toBe("project");
    expect(repo.absolutePath).toBe(path.join(root, "group/nested/project"));
    expect(repo.hydrate).toEqual({ status: "local", strategy: "eager" });
  });

  it("treats the workspace root itself as a repo when it contains .git", async () => {
    await mkdir(".git");

    const result = await scanWorkspace(root);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]!.relativePath).toBe(".");
  });

  it("throws a helpful error for a non-existent workspace", async () => {
    await expect(scanWorkspace(path.join(root, "does-not-exist"))).rejects.toThrow(
      /does not exist/,
    );
  });

  it("fails instead of returning an incomplete scan when a directory is unreadable", async () => {
    await mkdir("blocked");
    const entries = await fs.readdir(root, { withFileTypes: true });
    vi.spyOn(fs, "readdir")
      .mockResolvedValueOnce(entries as never)
      .mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    await expect(scanWorkspace(root)).rejects.toThrow(
      /Could not read workspace directory.*permission denied/,
    );
  });

  it("tolerates a child directory disappearing during traversal", async () => {
    await mkdir("vanished");
    const entries = await fs.readdir(root, { withFileTypes: true });
    const vanished = path.join(root, "vanished");
    vi.spyOn(fs, "readdir")
      .mockResolvedValueOnce(entries as never)
      .mockImplementationOnce(async () => {
        await fs.rm(vanished, { recursive: true, force: true });
        throw Object.assign(new Error("directory disappeared"), { code: "ENOENT" });
      });

    const result = await scanWorkspace(root);

    expect(result.repos).toEqual([]);
    expect(result.otherFolders).toEqual([]);
  });
});

describe("scanWorkspace — ignore rules", () => {
  it("does not descend into directories matched by the workspace ignore file", async () => {
    await touch(IGNORE_FILE_NAME, "scratch/\n");
    await mkdir("scratch/hidden-repo/.git");
    await mkdir("real/.git");

    const result = await scanWorkspace(root);
    const rels = result.repos.map((r) => r.relativePath);

    expect(rels).toEqual(["real"]);
    expect(result.hasWorkspaceIgnoreFile).toBe(true);
    expect(result.ignoreFiles).toHaveLength(1);
    expect(result.ignoreFiles[0]).toMatchObject({ scope: "workspace", rules: ["scratch/"] });
  });

  it("records repo-scoped ignore files in the result", async () => {
    await mkdir("apps/web/.git");
    await touch(`apps/web/${IGNORE_FILE_NAME}`, ".env\n*.log\n");

    const result = await scanWorkspace(root);
    const repoIgnore = result.ignoreFiles.find((f) => f.scope === "repo");
    expect(repoIgnore?.path).toBe(`apps/web/${IGNORE_FILE_NAME}`);
    expect(repoIgnore?.rules).toEqual([".env", "*.log"]);
  });

  it("merges ignore rules from the config file", async () => {
    await touch(CONFIG_FILE_NAME, "ignore:\n  - tmp\n");
    await mkdir("tmp/cached-repo/.git");
    await mkdir("keep/.git");

    const result = await scanWorkspace(root);
    expect(result.repos.map((r) => r.relativePath)).toEqual(["keep"]);
  });
});

describe("scanWorkspace — placeholders and other folders", () => {
  it("discovers placeholders and does not descend into them", async () => {
    const repoDir = path.join(root, "apps", "kplane");
    await fs.mkdir(repoDir, { recursive: true });
    await writePlaceholder(
      repoDir,
      buildPlaceholderMeta({
        name: "kplane",
        relativePath: "apps/kplane",
        remoteUrl: "git@github.com:dantelex2/kplane.git",
        currentBranch: "main",
        lastCommit: "abc123",
      }),
    );

    const result = await scanWorkspace(root);
    const placeholder = result.repos.find((r) => r.relativePath === "apps/kplane");
    expect(placeholder?.hydrate.status).toBe("placeholder");
    expect(placeholder?.remoteUrl).toBe("git@github.com:dantelex2/kplane.git");
    expect(placeholder?.currentBranch).toBe("main");
  });

  it("reports top-level folders that contain no repo or placeholder", async () => {
    await mkdir("apps/web/.git");
    await mkdir("scratch");
    await touch("notes/todo.md", "x");

    const result = await scanWorkspace(root);
    expect(result.otherFolders).toEqual(["notes", "scratch"]);
  });

  it("uses the workspace name from the config file as rootName", async () => {
    await touch(CONFIG_FILE_NAME, "workspace:\n  name: dante-code\n");
    const result = await scanWorkspace(root);
    expect(result.rootName).toBe("dante-code");
  });
});
