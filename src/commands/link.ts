import fs from "node:fs/promises";
import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { loadMachineIdentity } from "../core/identity";
import {
  emptyWorkspaceMap,
  isLinked,
  mapPaths,
  machineStateFromScan,
  mergeReposIntoMap,
  readWorkspaceMap,
  sharedRepoFromEntry,
  shortId,
  writeLinkConfig,
  writeMachineState,
  writeWorkspaceMap,
} from "../core/map";
import { reconcileFromMap } from "../core/reconcile";
import { scanWorkspace } from "../core/scanner";
import { cloneMap, initFolderMap, type MapTransport } from "../core/transport";
import { colors, logger } from "../ui/logger";
import { reconcileProgressHooks } from "../ui/plan";
import { withSpinner } from "../ui/progress";

export interface LinkOptions {
  eager?: boolean;
  /** Treat <remote> as an already-synced folder (Dropbox/Drive/…) instead of a git URL. */
  folder?: boolean;
}

/**
 * Connect a workspace to a shared boot map: clone the map, publish whatever is
 * already here, and recreate the structure for anything that only exists on
 * other machines. Works in both directions, so the very first machine seeds the
 * map and every later machine receives it.
 */
export async function linkCommand(
  remote: string,
  workspacePath = ".",
  options: LinkOptions = {},
): Promise<void> {
  await ensureGitAvailable();

  const root = path.resolve(workspacePath);
  await fs.mkdir(root, { recursive: true });

  const paths = mapPaths(root);
  if (isLinked(root)) {
    throw new Error(
      `${root} is already linked (${paths.mapDir}). Use \`boot pull\` / \`boot push\` to sync.`,
    );
  }

  const kind = options.folder ? "folder" : "git";
  logger.heading(
    `Linking ${colors.cyan(root)} to ${colors.cyan(remote)}${
      options.folder ? colors.dim(" (folder)") : ""
    }`,
  );

  const identity = await loadMachineIdentity();
  await fs.mkdir(paths.bootDir, { recursive: true });

  const transport: MapTransport = options.folder
    ? await withSpinner("syncing map from folder", () => initFolderMap(remote, paths.mapDir))
    : await withSpinner("cloning map", () => cloneMap(remote, paths.mapDir));

  let map = (await readWorkspaceMap(paths.mapDir)) ?? emptyWorkspaceMap(path.basename(root));
  await writeLinkConfig(root, { kind, remote, linkedAt: new Date().toISOString() });

  // Publish what this machine already has into the shared map.
  const scan = await scanWorkspace(root);
  map = mergeReposIntoMap(map, scan.repos.map(sharedRepoFromEntry), {
    ignoreFiles: scan.ignoreFiles,
    defaultIgnoreRules: scan.defaultIgnoreRules,
  });
  await writeWorkspaceMap(paths.mapDir, map);

  // Recreate structure for repos that only exist elsewhere.
  const recon = await reconcileFromMap(root, map.repos, {
    eager: options.eager,
    hooks: reconcileProgressHooks(),
  });
  if (recon.placeholders > 0) logger.success(`created ${recon.placeholders} placeholder(s)`);
  if (recon.cloned > 0) logger.success(`cloned ${recon.cloned} repo(s)`);

  // Register this machine (rescan so freshly-written placeholders are included).
  const rescan = await scanWorkspace(root);
  await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, rescan.repos));

  await transport.push(`link: ${identity.hostname} (${shortId(identity.machineId)})`);

  logger.info();
  logger.success(
    `Linked as ${colors.cyan(identity.hostname)}. ${map.repos.length} repo(s) in the map.`,
  );
  if (recon.placeholders > 0) {
    logger.info(colors.dim("Hydrate a repo with:  boot hydrate <relativePath>"));
  }
}
