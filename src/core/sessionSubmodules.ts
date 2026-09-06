import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { portableRelativePathSchema, resolveWorkspaceRepositoryPath } from "./pathUtils";
import { requireGit } from "./sessionStorage";
import type { ResolvedRepository } from "./workspace";
import type { SessionRecord } from "./sessionStore";

export interface SnapshotRepository {
  id: string; path: string; source: string; base: string; snapshot: string;
  submoduleOf?: string; gitlinkPath?: string;
}

async function gitlinks(directory: string, commit: string) {
  return (await requireGit(directory, ["ls-tree", "-r", "-z", commit])).split("\0").filter((entry) => entry.startsWith("160000 "))
    .map((entry) => ({ path: portableRelativePathSchema.parse(entry.slice(entry.indexOf("\t") + 1)), commit: entry.split(" ")[2]!.split("\t")[0]! }));
}

/** Discover pinned topology using Git objects, never by executing .gitmodules URLs. */
export async function snapshotRepositories(root: string, selected: ResolvedRepository[], workingTree: boolean): Promise<SnapshotRepository[]> {
  const result: SnapshotRepository[] = [];
  const visit = async (item: SnapshotRepository, depth: number): Promise<void> => {
    if (depth > 32 || result.length >= 1024) throw new Error("Submodule topology exceeds the supported depth or repository count.");
    const top = (await requireGit(item.source, ["rev-parse", "--show-toplevel"])).trim();
    if (await fs.realpath(top) !== await fs.realpath(item.source)) throw new Error(`Initialize source submodule ${item.path} with git submodule update --init --recursive before creating a session.`);
    await requireGit(item.source, ["cat-file", "-e", `${item.base}^{commit}`]);
    const children = await gitlinks(item.source, item.base);
    if (workingTree) {
      const indexed = (await requireGit(item.source, ["ls-files", "--stage", "-z"])).split("\0").filter((entry) => entry.startsWith("160000 "));
      const paths = indexed.map((entry) => entry.slice(entry.indexOf("\t") + 1)).sort();
      const currentPaths = (await gitlinks(item.source, item.snapshot)).map((child) => child.path).sort();
      if (JSON.stringify(paths) !== JSON.stringify(children.map((child) => child.path).sort()) || JSON.stringify(paths) !== JSON.stringify(currentPaths)
        || indexed.some((entry) => !entry.split("\t")[0]!.endsWith(" 0"))) {
        throw new Error("Commit submodule additions, removals, renames, and conflict resolutions before capturing working-tree state.");
      }
    }
    result.push(item);
    for (const child of children) {
      const relative = item.path === "." ? child.path : `${item.path}/${child.path}`;
      const source = resolveWorkspaceRepositoryPath(root, relative);
      if (!(await fs.lstat(path.join(source, ".git")).catch(() => null))) throw new Error(`Initialize source submodule ${relative} with git submodule update --init --recursive before creating a session.`);
      const snapshot = workingTree ? (await requireGit(source, ["rev-parse", "HEAD"])).trim() : child.commit;
      await visit({ id: `submodule-${createHash("sha256").update(relative).digest("hex").slice(0, 24)}`, path: relative, source,
        base: child.commit, snapshot, submoduleOf: item.id, gitlinkPath: child.path }, depth + 1);
    }
  };
  for (const repo of selected) {
    const source = resolveWorkspaceRepositoryPath(root, repo.path);
    const base = (await requireGit(source, ["rev-parse", "--verify", "--end-of-options", `${repo.ref ?? "HEAD"}^{commit}`])).trim();
    if (workingTree && (await requireGit(source, ["rev-parse", "HEAD"])).trim() !== base) throw new Error("Including working-tree state requires the requested commit to equal source HEAD.");
    await visit({ id: repo.id, path: repo.path, source, base, snapshot: base }, 0);
  }
  return result;
}

/** Restore parent indexes separately; the child's HEAD supplies the unstaged gitlink. */
export async function importSubmoduleIndexes(record: SessionRecord): Promise<void> {
  for (const child of record.repositories) {
    if (!child.submoduleOf || !child.gitlinkPath) continue;
    const parent = record.repositories.find((repo) => repo.id === child.submoduleOf)!;
    const entry = (await requireGit(parent.source, ["ls-files", "--stage", "-z", "--", child.gitlinkPath])).split("\0").filter(Boolean);
    if (entry.length !== 1 || !entry[0]!.startsWith("160000 ") || !entry[0]!.split("\t")[0]!.endsWith(" 0")) throw new Error("Source submodule index changed during capture; stop writers and retry.");
    const commit = entry[0]!.split(" ")[1]!;
    await requireGit(resolveWorkspaceRepositoryPath(record.root, parent.relativePath), ["update-index", "--cacheinfo", `160000,${commit},${child.gitlinkPath}`]);
    if (commit !== child.base || (child.snapshot ?? child.base) !== child.base) parent.importedChanges = true;
  }
}
