import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  cloneRepo,
  ensureGitAvailable,
  gitCommitAll,
  gitHasUnpushed,
  gitPullRebase,
  gitPush,
} from "./git";
import { mapPaths, readLinkConfig } from "./map";
import {
  fileReadError,
  isFileNotFoundError,
  quoteUserValue,
} from "./userErrors";

/**
 * A transport persists and shares "the map" — the small bundle of metadata that
 * describes a workspace — between machines. The rest of boot is written against
 * this interface so the backend can be swapped (git remote, a folder you already
 * sync, an object store, …) without touching the commands.
 */
export interface MapTransport {
  /** Local working directory the map is materialised into. */
  readonly mapDir: string;
  /** Bring the local map up to date with the remote. */
  pull(): Promise<void>;
  /** Commit any local changes and publish them. Returns true when something changed. */
  push(message: string): Promise<boolean>;
}

/**
 * Git-backed transport: the map is an ordinary (single, non-submodule) git repo.
 * Git runs everywhere boot does — including fresh cloud agents — and gives us
 * atomic updates, history, and real merges for free.
 */
export class GitMapTransport implements MapTransport {
  constructor(readonly mapDir: string) {}

  async pull(): Promise<void> {
    await gitPullRebase(this.mapDir);
  }

  async push(message: string): Promise<boolean> {
    const committed = await gitCommitAll(this.mapDir, message);
    if (committed || (await gitHasUnpushed(this.mapDir))) {
      await gitPush(this.mapDir);
    }
    return committed;
  }
}

/**
 * Folder-backed transport: the map lives in a directory that is *already* kept in
 * sync by something else (Dropbox, iCloud Drive, Google Drive, a network share).
 * boot just mirrors its local working copy to/from that folder. No git remote to
 * host — at the cost of git's atomic merges, so the host's own conflict handling
 * applies under truly concurrent writes.
 */
export class FolderTransport implements MapTransport {
  constructor(
    readonly mapDir: string,
    private readonly folder: string,
  ) {}

  async pull(): Promise<void> {
    if (existsSync(this.folder)) {
      await assertNoIcloudStubs(this.folder, "pull from synced folder");
      await mirrorTree(this.folder, this.mapDir);
    } else {
      await fs.mkdir(this.folder, { recursive: true });
    }
  }

  async push(_message: string): Promise<boolean> {
    await fs.mkdir(this.folder, { recursive: true });
    await assertNoIcloudStubs(this.mapDir, "push local map");
    return mirrorTree(this.mapDir, this.folder);
  }
}

/**
 * Clone a (possibly empty) git map remote into `mapDir` and return a transport.
 * Refuses to clobber an existing map directory.
 */
export async function cloneMap(remoteUrl: string, mapDir: string): Promise<GitMapTransport> {
  await ensureGitAvailable();
  if (existsSync(mapDir)) {
    throw new Error(
      `Workspace data directory ${quoteUserValue(mapDir, 500)} already exists. Choose an unlinked workspace or remove the existing link before retrying.`,
    );
  }
  await cloneRepo(remoteUrl, mapDir);
  return new GitMapTransport(mapDir);
}

/**
 * Initialise a folder-backed map: create the local working copy and seed it from
 * the shared folder if that folder already holds a map. Refuses to clobber an
 * existing map directory.
 */
export async function initFolderMap(folder: string, mapDir: string): Promise<FolderTransport> {
  if (existsSync(mapDir)) {
    throw new Error(
      `Workspace data directory ${quoteUserValue(mapDir, 500)} already exists. Choose an unlinked workspace or remove the existing link before retrying.`,
    );
  }
  await fs.mkdir(mapDir, { recursive: true });
  const transport = new FolderTransport(mapDir, path.resolve(folder));
  await transport.pull();
  return transport;
}

/**
 * Build the transport a workspace was linked with. Reads `link.json` and returns
 * the matching backend, defaulting to git for maps linked before folder support.
 */
export async function loadTransport(root: string): Promise<MapTransport> {
  const mapDir = mapPaths(root).mapDir;
  const config = await readLinkConfig(root);
  if (config?.kind === "folder") {
    return new FolderTransport(mapDir, config.remote);
  }
  return new GitMapTransport(mapDir);
}

/* ------------------------------------------------------------------ *
 * Directory mirroring (folder transport)                              *
 * ------------------------------------------------------------------ */

/** Recursively list file paths under `dir`, relative to it. */
async function listFilesRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch (error) {
      if (isFileNotFoundError(error)) return;
      throw fileReadError("synced workspace folder", path.join(dir, rel), error);
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await walk("");
  return out;
}

function isIcloudStub(rel: string): boolean {
  return path.basename(rel).endsWith(".icloud");
}

function formatRelList(files: string[]): string {
  const shown = files
    .slice(0, 5)
    .map((file) => quoteUserValue(file))
    .join(", ");
  const remaining = files.length - 5;
  return remaining > 0 ? `${shown}, and ${remaining} more` : shown;
}

async function assertNoIcloudStubs(dir: string, action: string): Promise<void> {
  const stubs = (await listFilesRel(dir)).filter(isIcloudStub).sort();
  if (stubs.length === 0) return;

  throw new Error(
    `Cannot ${action} because iCloud has not downloaded every file in ${quoteUserValue(dir, 500)}: ` +
      `${formatRelList(stubs)}. Wait for iCloud to download the files, then retry.`,
  );
}

/**
 * Make `dst` an exact mirror of `src` (copy changed files, prune extras).
 * Returns whether anything changed. The map is small, so byte-comparison is fine
 * and lets `push` report "already up to date" accurately.
 */
async function mirrorTree(src: string, dst: string): Promise<boolean> {
  await fs.mkdir(dst, { recursive: true });
  let changed = false;

  const srcFiles = await listFilesRel(src);
  const srcSet = new Set(srcFiles);

  for (const rel of srcFiles) {
    const data = await fs.readFile(path.join(src, rel));
    const target = path.join(dst, rel);
    let differs = true;
    try {
      differs = !(await fs.readFile(target)).equals(data);
    } catch {
      differs = true;
    }
    if (differs) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
      changed = true;
    }
  }

  for (const rel of await listFilesRel(dst)) {
    if (!srcSet.has(rel)) {
      await fs.rm(path.join(dst, rel), { force: true });
      changed = true;
    }
  }

  return changed;
}
