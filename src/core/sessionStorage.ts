import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execa } from "execa";
import { windowsCloneFiles } from "./sessionWindows";
import { macCloneFiles } from "./sessionNative";

export type StorageRequest = "auto" | "cow" | "worktree" | "clone";
export type StorageBackend = "apfs-clone" | "linux-reflink" | "refs-clone" | "worktree" | "clone";

/** Git diagnostics intentionally omit subprocess output, which can include credentials. */
export async function sessionGit(cwd: string, args: string[], input?: string) {
  return execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "gc.auto=0", "-c", "submodule.recurse=false", "-C", cwd, ...args], {
    input, reject: false,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined },
  });
}

export async function requireGit(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await sessionGit(cwd, args, input);
  if (result.exitCode !== 0) {
    // Classify known failures without exposing Git's paths, URLs, or output.
    const reason = /filename too long|file name too long/i.test(result.stderr) ? "; path exceeds Git's supported length"
      : /dubious ownership|unsafe repository/i.test(result.stderr) ? "; repository ownership rejected by Git"
      : /not a git repository/i.test(result.stderr) ? "; repository could not be opened"
      : /permission denied|access is denied/i.test(result.stderr) ? "; filesystem access denied" : "";
    throw new Error(`Session Git operation ${args[0]} failed (exit ${result.exitCode ?? "unknown"}${reason}). Inspect the repository directly for details.`);
  }
  return result.stdout;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function excludedSnapshotPath(relative: string): boolean {
  return relative.split("/").some((name) => name === ".boot" || name === ".ssh" || name === ".aws" || name === ".gnupg"
    || name === ".git-credentials" || name === ".netrc" || name === ".npmrc"
    || /^\.env(?:$|\.(?!example$|sample$|template$))/.test(name));
}

/** A stat-based change detector, not a content hash or a filesystem snapshot. */
export async function treeFingerprint(root: string, options: { allowGit?: boolean } = {}): Promise<string> {
  const hash = createHash("sha256");
  async function visit(target: string, relative: string): Promise<void> {
    const stat = await fs.lstat(target, { bigint: true });
    if (relative && excludedSnapshotPath(relative)) throw new Error(`Snapshot excludes credential or Boot state path: ${relative}`);
    if (!options.allowGit && relative.split("/").includes(".git")) return;
    hash.update(`${relative}\0${stat.mode}\0${stat.size}\0${stat.ino}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(target);
      if (path.isAbsolute(link) || !isWithin(root, path.resolve(path.dirname(target), link))) {
        throw new Error(`Snapshot contains a link that cannot be relocated independently: ${relative}`);
      }
      hash.update(link);
    } else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
    } else if (!stat.isFile()) {
      throw new Error(`Snapshot cannot include a socket, device, or other special file: ${relative}`);
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

/** Copy without following symlinks or sharing writable inodes. CoW is strict. */
export async function copyTree(source: string, destination: string, cow: boolean, options: { skipGit?: boolean; snapshotRoot?: string } = {}): Promise<void> {
  const snapshotRoot = options.snapshotRoot ?? source;
  const nativeFiles: Array<{ source: string; destination: string; mode: number }> = [];
  async function visit(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    if (path.isAbsolute(link) || !isWithin(snapshotRoot, path.resolve(path.dirname(source), link))) {
      throw new Error("Snapshot contains an absolute or escaping symlink; relocate it before creating a session.");
    }
    await fs.symlink(link, destination);
  } else if (stat.isDirectory()) {
    await fs.mkdir(destination, { mode: stat.mode & 0o777 });
    for (const name of await fs.readdir(source)) {
      if (name === ".boot" || (options.skipGit && name === ".git")) continue;
      if (excludedSnapshotPath(name)) throw new Error(`Snapshot excludes credential path: ${name}`);
      await visit(path.join(source, name), path.join(destination, name));
    }
  } else if (stat.isFile()) {
    if (cow && ["darwin", "win32"].includes(process.platform)) nativeFiles.push({ source, destination, mode: stat.mode & 0o777 });
    else {
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL | (cow ? constants.COPYFILE_FICLONE_FORCE : 0));
      await fs.chmod(destination, stat.mode & 0o777);
    }
  } else {
    throw new Error("Snapshot contains a socket, device, or other unsupported special file.");
  }
  }
  await visit(source, destination);
  if (nativeFiles.length) {
    if (process.platform === "win32") {
      await windowsCloneFiles(nativeFiles);
      for (const { destination, mode } of nativeFiles) await fs.chmod(destination, mode);
    }
    else await macCloneFiles(nativeFiles);
  }
}

export async function probeCow(sourceDirectory: string, destinationDirectory: string): Promise<{ backend: "apfs-clone" | "linux-reflink" | "refs-clone" | null; reason: string | null }> {
  if (!["darwin", "linux", "win32"].includes(process.platform)) return { backend: null, reason: `CoW is not implemented on ${process.platform}` };
  // Both scratch files are ours. Never modify a source repository to probe it.
  const from = path.join(sourceDirectory, `.cow-probe-${randomUUID()}`);
  const to = path.join(destinationDirectory, `.cow-probe-${randomUUID()}`);
  try {
    await fs.writeFile(from, "Boot CoW capability probe\n", { flag: "wx", mode: 0o600 });
    if (process.platform === "darwin") await macCloneFiles([{ source: from, destination: to }]);
    else if (process.platform === "win32") await windowsCloneFiles([{ source: from, destination: to }]);
    else await fs.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    return { backend: process.platform === "darwin" ? "apfs-clone" : process.platform === "win32" ? "refs-clone" : "linux-reflink", reason: null };
  } catch (error) {
    if (["EHELPERUNAVAILABLE", "EHELPERBUILD"].includes((error as NodeJS.ErrnoException).code ?? "")) return { backend: null, reason: (error as Error).message };
    return { backend: null, reason: `Native forced CoW failed (${(error as NodeJS.ErrnoException).code ?? "unknown"}); source and destination must support cloning on the same filesystem` };
  } finally {
    await fs.rm(from, { force: true });
    await fs.rm(to, { force: true });
  }
}
