import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { loadMachineIdentity } from "../core/identity";
import { withWorkspaceMapLock } from "../core/lock";
import {
  emptyWorkspaceMap,
  isLinked,
  mapPaths,
  machineStateFromScan,
  mergeReposIntoMap,
  mergeWorkspaceDefinitionIntoMap,
  readWorkspaceMap,
  sharedRepoFromEntry,
  writeMachineState,
  writeWorkspaceMap,
} from "../core/map";
import { scanWorkspace } from "../core/scanner";
import { loadTransport } from "../core/transport";
import { writePublishedWorkspace } from "../core/workspaceStore";
import { colors, logger } from "../ui/logger";

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Scan this workspace and publish its structure to the shared map. Pulls the
 * latest map first so concurrent edits from other machines merge cleanly.
 */
export async function pushCommand(workspacePath = "."): Promise<void> {
  await ensureGitAvailable();

  const root = path.resolve(workspacePath);
  if (!isLinked(root)) {
    throw new Error(
      `This workspace is not linked. Run: boot link <map-remote> ${commandArg(root)}`,
    );
  }

  await withWorkspaceMapLock(root, async () => {
    logger.heading(`Publish workspace map — ${colors.cyan(root)}`);

    const identity = await loadMachineIdentity();
    const paths = mapPaths(root);
    const transport = await loadTransport(root);

    await transport.pull();
    logger.success("Pulled the latest workspace map.");

    const scan = await scanWorkspace(root);
    let map = (await readWorkspaceMap(paths.mapDir)) ?? emptyWorkspaceMap(scan.rootName);
    map = mergeReposIntoMap(map, scan.repos.map(sharedRepoFromEntry), {
      ignoreFiles: scan.ignoreFiles,
      defaultIgnoreRules: scan.defaultIgnoreRules,
    });
    if (scan.config.definition) {
      map = mergeWorkspaceDefinitionIntoMap(map, scan.config.definition);
      await writePublishedWorkspace(paths.mapDir, scan.config.definition);
    }
    await writeWorkspaceMap(paths.mapDir, map);
    await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, scan.repos));

    const pushed = await transport.push(
      `push: ${scan.repos.length} ${
        scan.repos.length === 1 ? "repository" : "repositories"
      } from ${identity.hostname}`,
    );

    logger.info();
    if (pushed) {
      logger.success(
        `Published ${map.repos.length} ${
          map.repos.length === 1 ? "repository" : "repositories"
        } to the workspace map.`,
      );
      logger.next("On each other machine, run from its workspace: boot pull");
    } else {
      logger.info(
        `Already up to date. The workspace map has ${map.repos.length} ${
          map.repos.length === 1 ? "repository" : "repositories"
        }.`,
      );
    }
  });
}
