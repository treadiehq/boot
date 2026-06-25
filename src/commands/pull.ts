import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { loadMachineIdentity } from "../core/identity";
import {
  isLinked,
  mapPaths,
  machineStateFromScan,
  readWorkspaceMap,
  writeMachineState,
} from "../core/map";
import { reconcileFromMap } from "../core/reconcile";
import { scanWorkspace } from "../core/scanner";
import { loadTransport } from "../core/transport";
import { colors, logger } from "../ui/logger";
import { renderPlan, reconcileProgressHooks } from "../ui/plan";

export interface PullOptions {
  eager?: boolean;
  /** Show what would change without writing anything. */
  dryRun?: boolean;
}

/**
 * Fetch the shared map and recreate any structure missing on this machine
 * (placeholders by default, clones with `--eager`).
 */
export async function pullCommand(workspacePath = ".", options: PullOptions = {}): Promise<void> {
  await ensureGitAvailable();

  const root = path.resolve(workspacePath);
  if (!isLinked(root)) {
    throw new Error(`${root} is not linked. Run \`boot link <remote> ${workspacePath}\` first.`);
  }

  logger.heading(`Pulling the map into ${colors.cyan(root)}`);

  const identity = await loadMachineIdentity();
  const paths = mapPaths(root);
  const transport = await loadTransport(root);

  await transport.pull();
  logger.success("pulled latest map");

  const map = await readWorkspaceMap(paths.mapDir);
  if (!map) {
    logger.warn("the map has no workspace.json yet — nothing to restore.");
    return;
  }

  if (options.dryRun) {
    logger.info();
    const plan = await reconcileFromMap(root, map.repos, { eager: options.eager, dryRun: true });
    renderPlan(plan);
    return;
  }

  const recon = await reconcileFromMap(root, map.repos, {
    eager: options.eager,
    hooks: reconcileProgressHooks(),
  });
  if (recon.placeholders > 0) logger.success(`created ${recon.placeholders} placeholder(s)`);
  if (recon.cloned > 0) logger.success(`cloned ${recon.cloned} repo(s)`);

  // Record this machine's updated state. Best-effort: a failed publish of our
  // own state shouldn't fail the pull.
  const scan = await scanWorkspace(root);
  await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, scan.repos));
  try {
    await transport.push(`pull: update ${identity.hostname} state`);
  } catch (err) {
    logger.warn(`could not publish machine state: ${(err as Error).message}`);
  }

  logger.info();
  logger.success(`Up to date. ${map.repos.length} repo(s) in the map.`);
  if (!options.eager && recon.placeholders > 0) {
    logger.next('Repos hydrate on access once you add:  eval "$(boot shell-hook zsh)"');
  }
}
