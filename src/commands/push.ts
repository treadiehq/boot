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
  writeMachineState,
  writeWorkspaceMap,
} from "../core/map";
import { scanWorkspace } from "../core/scanner";
import { loadTransport } from "../core/transport";
import { colors, logger } from "../ui/logger";

/**
 * Scan this workspace and publish its structure to the shared map. Pulls the
 * latest map first so concurrent edits from other machines merge cleanly.
 */
export async function pushCommand(workspacePath = "."): Promise<void> {
  await ensureGitAvailable();

  const root = path.resolve(workspacePath);
  if (!isLinked(root)) {
    throw new Error(`${root} is not linked. Run \`boot link <remote> ${workspacePath}\` first.`);
  }

  logger.heading(`Pushing ${colors.cyan(root)} to the map`);

  const identity = await loadMachineIdentity();
  const paths = mapPaths(root);
  const transport = await loadTransport(root);

  await transport.pull();
  logger.success("pulled latest map");

  const scan = await scanWorkspace(root);
  let map = (await readWorkspaceMap(paths.mapDir)) ?? emptyWorkspaceMap(scan.rootName);
  map = mergeReposIntoMap(map, scan.repos.map(sharedRepoFromEntry), {
    ignoreFiles: scan.ignoreFiles,
    defaultIgnoreRules: scan.defaultIgnoreRules,
  });
  await writeWorkspaceMap(paths.mapDir, map);
  await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, scan.repos));

  const pushed = await transport.push(
    `push: ${scan.repos.length} repo(s) from ${identity.hostname}`,
  );

  logger.info();
  if (pushed) {
    logger.success(`Pushed. ${map.repos.length} repo(s) in the map.`);
    logger.next("On your other machines:  boot pull");
  } else {
    logger.info(`Already up to date. ${map.repos.length} repo(s) in the map.`);
  }
}
