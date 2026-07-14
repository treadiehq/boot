import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  getCurrentBranch,
  getLastCommit,
  getRemoteUrl,
  isDirty,
  isGitRepo,
} from "./git";
import { loadConfig, type ResolvedConfig } from "./config";
import {
  createIgnoreMatcher,
  DEFAULT_IGNORE_RULES,
  IGNORE_FILE_NAME,
  loadIgnoreFileEntry,
  type IgnoreFileEntry,
  type IgnoreMatcher,
} from "./ignore";
import { detectProject } from "./projectDetect";
import { isPlaceholder, readPlaceholder } from "./placeholder";
import type { HydrateInfo, RepoEntry } from "./manifest";
import { toPosixRelative } from "./pathUtils";
import { fileReadError, isFileNotFoundError, sanitizeUserText } from "./userErrors";

/** Safety bound so a pathological tree can never recurse forever. */
const MAX_DEPTH = 12;

export interface ScanResult {
  rootName: string;
  sourcePath: string;
  config: ResolvedConfig;
  ignoreFiles: IgnoreFileEntry[];
  defaultIgnoreRules: string[];
  /** Git repos and placeholders, sorted by relative path. */
  repos: RepoEntry[];
  /** Top-level folders that contain neither a repo nor a placeholder. */
  otherFolders: string[];
  /** Whether a `.bootignore` exists at the workspace root. */
  hasWorkspaceIgnoreFile: boolean;
}

interface Discovered {
  /** Absolute path of a git repo or a placeholder folder. */
  dir: string;
  isGit: boolean;
  isPlaceholderDir: boolean;
}

export async function scanWorkspace(workspacePath: string): Promise<ScanResult> {
  const root = path.resolve(workspacePath);

  let stat;
  try {
    stat = await fs.stat(root);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(
        `Workspace path does not exist: ${sanitizeUserText(root)}. Create it or choose an existing directory, then retry.`,
      );
    }
    throw fileReadError("workspace path", root, error);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Workspace path is not a directory: ${sanitizeUserText(root)}. Choose a directory, then retry.`,
    );
  }

  const config = await loadConfig(root);

  const ignoreFiles: IgnoreFileEntry[] = [];
  const workspaceIgnore = await loadIgnoreFileEntry(root, root, "workspace");
  if (workspaceIgnore) ignoreFiles.push(workspaceIgnore);

  const matcher = createIgnoreMatcher([
    ...DEFAULT_IGNORE_RULES,
    ...config.ignore,
    ...(workspaceIgnore?.rules ?? []),
  ]);

  const discovered: Discovered[] = [];
  await walk(root, 0, matcher, discovered);
  discovered.sort((a, b) => a.dir.localeCompare(b.dir));

  const repos: RepoEntry[] = [];
  for (const item of discovered) {
    const entry = await buildRepoEntry(root, item, config.hydrateStrategy);
    repos.push(entry);

    // Record repo-scoped ignore files in the manifest.
    const repoIgnore = await loadIgnoreFileEntry(root, item.dir, "repo");
    if (repoIgnore) ignoreFiles.push(repoIgnore);
  }

  const otherFolders = await collectOtherFolders(root, matcher, discovered);

  return {
    rootName: config.workspaceName ?? path.basename(root),
    sourcePath: root,
    config,
    ignoreFiles,
    defaultIgnoreRules: [...DEFAULT_IGNORE_RULES],
    repos,
    otherFolders,
    hasWorkspaceIgnoreFile: existsSync(path.join(root, IGNORE_FILE_NAME)),
  };
}

async function walk(
  dir: string,
  depth: number,
  matcher: IgnoreMatcher,
  found: Discovered[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  const git = isGitRepo(dir);
  const placeholder = isPlaceholder(dir);
  if (git || placeholder) {
    // A repo or placeholder is a boundary — never descend into it.
    found.push({ dir, isGit: git, isPlaceholderDir: placeholder });
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip it gracefully
  }

  for (const entry of entries) {
    // Only follow real directories: skips files and symlinks (which also
    // prevents symlink cycles from causing infinite recursion).
    if (!entry.isDirectory()) continue;
    if (matcher.isIgnored(entry.name, true)) continue;
    await walk(path.join(dir, entry.name), depth + 1, matcher, found);
  }
}

function deriveHydrate(item: Discovered, strategy: HydrateInfo["strategy"]): HydrateInfo {
  if (item.isGit) {
    return { status: item.isPlaceholderDir ? "hydrated" : "local", strategy };
  }
  return { status: "placeholder", strategy };
}

async function buildRepoEntry(
  root: string,
  item: Discovered,
  strategy: HydrateInfo["strategy"],
): Promise<RepoEntry> {
  const relativePath = toPosixRelative(root, item.dir) || ".";
  const hydrate = deriveHydrate(item, strategy);

  if (item.isGit) {
    const [remoteUrl, currentBranch, dirty, lastCommit, project] = await Promise.all([
      getRemoteUrl(item.dir),
      getCurrentBranch(item.dir),
      isDirty(item.dir),
      getLastCommit(item.dir),
      detectProject(item.dir),
    ]);

    return {
      name: path.basename(item.dir),
      relativePath,
      absolutePath: item.dir,
      remoteUrl,
      currentBranch,
      dirty,
      lastCommit,
      packageManager: project.packageManager,
      projectType: project.projectType,
      detectedFiles: project.detectedFiles,
      ignoredHints: project.ignoredHints,
      hydrate,
    };
  }

  // Placeholder-only folder: pull metadata from .boot/repo.json.
  const meta = await readPlaceholder(item.dir);
  return {
    name: meta?.name ?? path.basename(item.dir),
    relativePath,
    absolutePath: item.dir,
    remoteUrl: meta?.remoteUrl ?? null,
    currentBranch: meta?.branch ?? null,
    dirty: false,
    lastCommit: meta?.lastCommit ?? null,
    packageManager: null,
    projectType: "unknown",
    detectedFiles: [],
    ignoredHints: [],
    hydrate,
  };
}

/**
 * Top-level (depth-1) directories that are not ignored and that do not contain
 * any discovered repo/placeholder anywhere beneath them.
 */
async function collectOtherFolders(
  root: string,
  matcher: IgnoreMatcher,
  discovered: Discovered[],
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const repoRoots = discovered.map((d) => d.dir);
  const others: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (matcher.isIgnored(entry.name, true)) continue;

    const abs = path.join(root, entry.name);
    const containsRepo = repoRoots.some((dir) => dir === abs || dir.startsWith(`${abs}${path.sep}`));
    if (!containsRepo) others.push(entry.name);
  }

  return others.sort();
}
