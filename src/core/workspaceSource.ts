import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withWorkspaceMapLock } from "./lock";
import {
  isLinked,
  mapPaths,
  readLinkConfig,
  readWorkspaceMap,
  writeLinkConfig,
  type LinkConfig,
} from "./map";
import {
  cloneMap,
  initFolderMap,
  loadTransport,
  type MapTransport,
} from "./transport";
import { quoteUserValue, sanitizeRemoteUrl } from "./userErrors";

export type WorkspaceSourceKind = "git" | "folder";
export type WorkspaceSourceState = "linked" | "updated" | "cached" | "preview";

export interface WorkspaceSource {
  kind: WorkspaceSourceKind;
  state: WorkspaceSourceState;
  mapDir: string;
  /** Root whose .boot/map points at mapDir. Used for side-effect-free previews. */
  inspectionRoot: string;
  transport?: MapTransport;
  cleanup(): Promise<void>;
}

export interface WorkspaceSourceOptions {
  folder?: boolean;
  dryRun?: boolean;
}

function sourceKind(options: WorkspaceSourceOptions): WorkspaceSourceKind {
  return options.folder ? "folder" : "git";
}

function normalizedSource(kind: WorkspaceSourceKind, value: string): string {
  if (kind === "folder") return path.resolve(value);
  return value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

function displayedSource(kind: WorkspaceSourceKind, value: string): string {
  return kind === "git" ? sanitizeRemoteUrl(value) : path.resolve(value);
}

async function assertMatchingSource(
  root: string,
  remote: string,
  kind: WorkspaceSourceKind,
): Promise<LinkConfig> {
  const current = await readLinkConfig(root);
  if (!current) {
    throw new Error(
      `Workspace ${quoteUserValue(root, 500)} has workspace data but no link settings. ` +
        "Run `boot doctor --system` and repair the link before retrying.",
    );
  }
  if (
    current.kind !== kind ||
    normalizedSource(current.kind, current.remote) !== normalizedSource(kind, remote)
  ) {
    throw new Error(
      `Workspace ${quoteUserValue(root, 500)} is already linked to ` +
        `${quoteUserValue(displayedSource(current.kind, current.remote), 500)} ` +
        `with the ${current.kind} transport, not ` +
        `${quoteUserValue(displayedSource(kind, remote), 500)} with the ${kind} transport. ` +
        "Use the existing source or choose an unlinked workspace.",
    );
  }
  return current;
}

/**
 * Initialize a workspace-map working copy without reconciling repository
 * topology. Commands decide whether to apply the compatibility map or a
 * resolved workspace profile after the canonical definition has been loaded.
 */
export async function initializeWorkspaceSource(
  remote: string,
  root: string,
  options: WorkspaceSourceOptions = {},
): Promise<WorkspaceSource> {
  const absoluteRoot = path.resolve(root);
  const kind = sourceKind(options);
  const paths = mapPaths(absoluteRoot);
  await fs.mkdir(paths.bootDir, { recursive: true });

  let transport: MapTransport | undefined;
  try {
    transport =
      kind === "folder"
        ? await initFolderMap(remote, paths.mapDir)
        : await cloneMap(remote, paths.mapDir);
    // Validate imported compatibility data before persisting the link pointer.
    await readWorkspaceMap(paths.mapDir);
    await writeLinkConfig(absoluteRoot, {
      kind,
      remote: kind === "folder" ? path.resolve(remote) : remote,
      linkedAt: new Date().toISOString(),
    });
  } catch (error) {
    await fs.rm(paths.mapDir, { recursive: true, force: true });
    await fs.rm(paths.linkPath, { force: true });
    throw error;
  }

  return {
    kind,
    state: "linked",
    mapDir: paths.mapDir,
    inspectionRoot: absoluteRoot,
    transport,
    cleanup: async () => undefined,
  };
}

async function previewWorkspaceSource(
  remote: string,
  options: WorkspaceSourceOptions,
): Promise<WorkspaceSource> {
  const kind = sourceKind(options);
  const previewRoot = await fs.mkdtemp(path.join(os.tmpdir(), "boot-source-preview-"));
  const paths = mapPaths(previewRoot);
  await fs.mkdir(paths.bootDir, { recursive: true });
  try {
    const transport =
      kind === "folder"
        ? await initFolderMap(remote, paths.mapDir)
        : await cloneMap(remote, paths.mapDir);
    await readWorkspaceMap(paths.mapDir);
    await writeLinkConfig(previewRoot, {
      kind,
      remote: kind === "folder" ? path.resolve(remote) : remote,
      linkedAt: new Date().toISOString(),
    });
    return {
      kind,
      state: "preview",
      mapDir: paths.mapDir,
      inspectionRoot: previewRoot,
      transport,
      cleanup: () => fs.rm(previewRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(previewRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Open a map for a one-shot bootstrap. Repeated runs verify the source and pull
 * it under the workspace lock. A fresh dry run clones into a temporary root so
 * the requested workspace remains untouched.
 */
export async function openWorkspaceSource(
  remote: string,
  root: string,
  options: WorkspaceSourceOptions = {},
): Promise<WorkspaceSource> {
  const absoluteRoot = path.resolve(root);
  const kind = sourceKind(options);

  if (!isLinked(absoluteRoot)) {
    if (options.dryRun) return previewWorkspaceSource(remote, options);
    return withWorkspaceMapLock(absoluteRoot, () =>
      initializeWorkspaceSource(remote, absoluteRoot, options),
    );
  }

  await assertMatchingSource(absoluteRoot, remote, kind);
  const transport = await loadTransport(absoluteRoot);
  if (!options.dryRun) {
    await withWorkspaceMapLock(absoluteRoot, () => transport.pull());
  }
  return {
    kind,
    state: options.dryRun ? "cached" : "updated",
    mapDir: mapPaths(absoluteRoot).mapDir,
    inspectionRoot: absoluteRoot,
    transport,
    cleanup: async () => undefined,
  };
}
