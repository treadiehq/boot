import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  hydrateStatusSchema,
  manifestConfigSchema,
  packageManagerSchema,
  projectTypeSchema,
  type ManifestConfig,
  type RepoEntry,
} from "./manifest";
import type { MachineIdentity } from "./identity";

export const MAP_VERSION = "1" as const;

/** Workspace-level directory that holds all of boot's per-workspace state. */
export const BOOT_DIR_NAME = ".boot";
/** The cloned map repo lives here, under the boot dir. */
export const MAP_REPO_DIR = "map";
export const WORKSPACE_MAP_FILE = "workspace.json";
export const MACHINES_DIR = "machines";
/** Machine-local link pointer (never committed to the map repo). */
export const LINK_FILE = "link.json";

/* ------------------------------------------------------------------ *
 * Schemas                                                            *
 * ------------------------------------------------------------------ */

/**
 * The machine-independent description of a repo. This is the shared truth that
 * is identical on every machine — note the absence of absolute paths,
 * dirty-state, or hydrate-status, all of which are per-machine facts.
 */
export const sharedRepoSchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  remoteUrl: z.string().nullable(),
  branch: z.string().nullable(),
  lastCommit: z.string().nullable(),
  packageManager: packageManagerSchema,
  projectType: projectTypeSchema,
});

export type SharedRepo = z.infer<typeof sharedRepoSchema>;

export const workspaceMapSchema = z.object({
  version: z.literal(MAP_VERSION),
  workspace: z.object({ name: z.string() }),
  updatedAt: z.string(),
  config: manifestConfigSchema,
  repos: z.array(sharedRepoSchema),
});

export type WorkspaceMap = z.infer<typeof workspaceMapSchema>;

export const machineRepoStateSchema = z.object({
  hydrateStatus: hydrateStatusSchema,
  lastCommit: z.string().nullable(),
  dirty: z.boolean(),
});

export type MachineRepoState = z.infer<typeof machineRepoStateSchema>;

/** A single machine's view: where the workspace lives and what it has hydrated. */
export const machineStateSchema = z.object({
  version: z.literal(MAP_VERSION),
  machineId: z.string(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  root: z.string(),
  updatedAt: z.string(),
  repos: z.record(z.string(), machineRepoStateSchema),
});

export type MachineState = z.infer<typeof machineStateSchema>;

export const linkConfigSchema = z.object({
  /** Which transport backs this map. Older link files predate folder support. */
  kind: z.enum(["git", "folder"]).default("git"),
  remote: z.string(),
  linkedAt: z.string(),
});

export type LinkConfig = z.infer<typeof linkConfigSchema>;

/* ------------------------------------------------------------------ *
 * Paths                                                              *
 * ------------------------------------------------------------------ */

export interface MapPaths {
  root: string;
  bootDir: string;
  mapDir: string;
  workspaceMap: string;
  machinesDir: string;
  linkPath: string;
}

export function mapPaths(root: string): MapPaths {
  const abs = path.resolve(root);
  const bootDir = path.join(abs, BOOT_DIR_NAME);
  const mapDir = path.join(bootDir, MAP_REPO_DIR);
  return {
    root: abs,
    bootDir,
    mapDir,
    workspaceMap: path.join(mapDir, WORKSPACE_MAP_FILE),
    machinesDir: path.join(mapDir, MACHINES_DIR),
    linkPath: path.join(bootDir, LINK_FILE),
  };
}

export function machineStatePath(mapDir: string, machineId: string): string {
  return path.join(mapDir, MACHINES_DIR, `${machineId}.json`);
}

/** A workspace is "linked" once its map repo has been cloned locally. */
export function isLinked(root: string): boolean {
  return existsSync(mapPaths(root).mapDir);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * Read / write                                                       *
 * ------------------------------------------------------------------ */

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

export function emptyWorkspaceMap(name: string): WorkspaceMap {
  return {
    version: MAP_VERSION,
    workspace: { name },
    updatedAt: new Date().toISOString(),
    config: { ignoreFiles: [], defaultIgnoreRules: [] },
    repos: [],
  };
}

export async function readWorkspaceMap(mapDir: string): Promise<WorkspaceMap | null> {
  const file = path.join(mapDir, WORKSPACE_MAP_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Workspace map is not valid JSON: ${file}`);
  }

  const result = workspaceMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Workspace map failed validation: ${file}\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export async function writeWorkspaceMap(mapDir: string, map: WorkspaceMap): Promise<void> {
  await fs.mkdir(mapDir, { recursive: true });
  const file = path.join(mapDir, WORKSPACE_MAP_FILE);
  await fs.writeFile(file, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

export async function readMachineState(
  mapDir: string,
  machineId: string,
): Promise<MachineState | null> {
  const file = machineStatePath(mapDir, machineId);

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Machine state is not valid JSON: ${file}`);
  }

  const result = machineStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Machine state failed validation: ${file}\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export async function writeMachineState(mapDir: string, state: MachineState): Promise<void> {
  const dir = path.join(mapDir, MACHINES_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${state.machineId}.json`);
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readLinkConfig(root: string): Promise<LinkConfig | null> {
  const { linkPath } = mapPaths(root);
  try {
    const raw = await fs.readFile(linkPath, "utf8");
    const parsed = linkConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeLinkConfig(root: string, config: LinkConfig): Promise<void> {
  const { bootDir, linkPath } = mapPaths(root);
  await fs.mkdir(bootDir, { recursive: true });
  await fs.writeFile(linkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ *
 * Derivation & merge                                                 *
 * ------------------------------------------------------------------ */

/** Project a full scanned repo entry down to its machine-independent shape. */
export function sharedRepoFromEntry(repo: RepoEntry): SharedRepo {
  return {
    name: repo.name,
    relativePath: repo.relativePath,
    remoteUrl: repo.remoteUrl,
    branch: repo.currentBranch,
    lastCommit: repo.lastCommit,
    packageManager: repo.packageManager,
    projectType: repo.projectType,
  };
}

/**
 * Upsert scanned repos into the shared map, keyed by `relativePath`. This is a
 * structural merge: it never deletes (a repo absent locally may still live on
 * another machine), and it never lets a placeholder-only scan clobber concrete
 * info (a known remote/branch/commit) with `null`.
 */
export function mergeReposIntoMap(
  map: WorkspaceMap,
  scanned: SharedRepo[],
  config: ManifestConfig,
): WorkspaceMap {
  const byPath = new Map(map.repos.map((r) => [r.relativePath, r] as const));

  for (const repo of scanned) {
    const existing = byPath.get(repo.relativePath);
    if (existing) {
      byPath.set(repo.relativePath, {
        ...existing,
        ...repo,
        remoteUrl: repo.remoteUrl ?? existing.remoteUrl,
        branch: repo.branch ?? existing.branch,
        lastCommit: repo.lastCommit ?? existing.lastCommit,
      });
    } else {
      byPath.set(repo.relativePath, repo);
    }
  }

  const repos = [...byPath.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  // Keep whichever ignore config is more informative rather than blindly
  // overwriting (a fresh machine with no `.bootignore` shouldn't erase rules).
  const mergedConfig: ManifestConfig = {
    ignoreFiles: config.ignoreFiles.length > 0 ? config.ignoreFiles : map.config.ignoreFiles,
    defaultIgnoreRules:
      config.defaultIgnoreRules.length > 0
        ? config.defaultIgnoreRules
        : map.config.defaultIgnoreRules,
  };

  return { ...map, updatedAt: new Date().toISOString(), config: mergedConfig, repos };
}

/** Build this machine's state snapshot from a scan of its workspace. */
export function machineStateFromScan(
  identity: MachineIdentity,
  root: string,
  repos: RepoEntry[],
): MachineState {
  const repoStates: Record<string, MachineRepoState> = {};
  for (const repo of repos) {
    repoStates[repo.relativePath] = {
      hydrateStatus: repo.hydrate.status,
      lastCommit: repo.lastCommit,
      dirty: repo.dirty,
    };
  }

  return {
    version: MAP_VERSION,
    machineId: identity.machineId,
    hostname: identity.hostname,
    platform: process.platform,
    arch: process.arch,
    root: path.resolve(root),
    updatedAt: new Date().toISOString(),
    repos: repoStates,
  };
}
