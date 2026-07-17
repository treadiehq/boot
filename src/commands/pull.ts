import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { detectShell, hookEvalLine } from "../core/health";
import { loadMachineIdentity } from "../core/identity";
import { withWorkspaceMapLock } from "../core/lock";
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
import { renderPlan, renderReconcileFailures, reconcileProgressHooks } from "../ui/plan";

export interface PullOptions {
  eager?: boolean;
  /** Show what would change without writing anything. */
  dryRun?: boolean;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Fetch the shared map and recreate any structure missing on this machine
 * (placeholders by default, clones with `--eager`).
 */
export async function pullCommand(workspacePath = ".", options: PullOptions = {}): Promise<void> {
  await ensureGitAvailable();

  const root = path.resolve(workspacePath);
  if (!isLinked(root)) {
    throw new Error(
      `This workspace is not linked. Run: boot link <map-remote> ${commandArg(root)}`,
    );
  }

  logger.heading(`Update workspace map — ${colors.cyan(root)}`);

  const paths = mapPaths(root);
  const transport = await loadTransport(root);

  if (options.dryRun) {
    const cachedMap = await readWorkspaceMap(paths.mapDir);
    if (!cachedMap) {
      logger.warn("The cached workspace map is empty, so there is nothing to preview.");
      return;
    }
    logger.info(colors.dim("Dry run: using the cached workspace map without pulling changes."));
    logger.info();
    const plan = await reconcileFromMap(root, cachedMap.repos, {
      eager: options.eager,
      dryRun: true,
    });
    renderPlan(plan);
    return;
  }

  await withWorkspaceMapLock(root, async () => {
    await transport.pull();
    logger.success("Pulled the latest workspace map.");

    const map = await readWorkspaceMap(paths.mapDir);
    if (!map) {
      logger.warn("The workspace map is empty, so there is nothing to prepare.");
      return;
    }

    const identity = await loadMachineIdentity();
    const recon = await reconcileFromMap(root, map.repos, {
      eager: options.eager,
      hooks: reconcileProgressHooks(),
    });
    if (recon.placeholders > 0) {
      logger.success(
        `Prepared ${recon.placeholders} repository ${
          recon.placeholders === 1 ? "placeholder" : "placeholders"
        }. Each placeholder clones its repository on first use.`,
      );
    }
    if (recon.cloned > 0) {
      logger.success(
        `Cloned ${recon.cloned} ${recon.cloned === 1 ? "repository" : "repositories"}.`,
      );
    }
    renderReconcileFailures(recon.failures);

    // Record this machine's updated state. Best-effort: a failed publish of our
    // own state shouldn't fail the pull.
    const scan = await scanWorkspace(root);
    await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, scan.repos));
    try {
      await transport.push(`pull: update ${identity.hostname} state`);
    } catch (err) {
      logger.warn(`Could not update this machine in the workspace map: ${(err as Error).message}`);
    }

    if (recon.failures.length > 0) {
      throw new Error(
        `The workspace map was updated, but ${recon.failures.length} ${
          recon.failures.length === 1 ? "repository" : "repositories"
        } could not be cloned. Fix the reported problems, then run: boot pull ${commandArg(root)} --eager`,
      );
    }

    logger.info();
    logger.success(
      `Up to date. The workspace map has ${map.repos.length} ${
        map.repos.length === 1 ? "repository" : "repositories"
      }.`,
    );
    if (!options.eager && recon.placeholders > 0) {
      const placeholder = scan.repos.find(
        (repository) => repository.hydrate.status === "placeholder" && repository.remoteUrl,
      );
      if (placeholder) {
        logger.next(`Clone one now: boot hydrate ${commandArg(placeholder.absolutePath)}`);
      }
      const shell = detectShell();
      if (shell) {
        logger.next(`Clone placeholders on access after adding: ${hookEvalLine(shell)}`);
      } else {
        logger.next("Set up clone-on-access for your shell: boot shell-hook --help");
      }
    }
  });
}
