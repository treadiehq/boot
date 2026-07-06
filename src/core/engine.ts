import { loadConfig } from "./config";
import { runFreshness, type FreshnessReport } from "./freshness";
import { loadMachineIdentity } from "./identity";
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
} from "./map";
import { reconcileFromMap, type ReconcileResult } from "./reconcile";
import { scanWorkspace } from "./scanner";
import { loadTransport } from "./transport";

export interface SyncOptions {
  /** Recreate missing repos by cloning instead of writing placeholders. */
  eager?: boolean;
  /** Fetch remotes and assess/advance repo freshness. Defaults to config. */
  fetch?: boolean;
  /** Fast-forward clean default-branch repos. Defaults to config. */
  fastForward?: boolean;
}

export interface TickResult {
  reconciled: ReconcileResult;
  freshness: FreshnessReport;
  pushed: boolean;
  repoCount: number;
}

/**
 * One end-to-end sync: pull the shared map, recreate anything missing, refresh
 * hydrated repos against their remotes, then publish this machine's view back.
 * This is the unit the daemon repeats — and the thing that keeps every machine
 * structurally identical and never building on a stale base.
 */
export async function syncOnce(root: string, options: SyncOptions = {}): Promise<TickResult> {
  if (!isLinked(root)) {
    throw new Error(`${root} is not linked. Run \`boot link <remote> ${root}\` first.`);
  }

  const config = await loadConfig(root);
  const doFetch = options.fetch ?? config.daemonFetch;
  const doFastForward = options.fastForward ?? config.daemonFastForward;

  const identity = await loadMachineIdentity();
  const paths = mapPaths(root);
  const transport = await loadTransport(root);

  // 1. Pull the latest shared map.
  await transport.pull();

  // 2. Recreate structure for repos that only exist on other machines.
  const map = (await readWorkspaceMap(paths.mapDir)) ?? emptyWorkspaceMap(root);
  const reconciled = await reconcileFromMap(root, map.repos, { eager: options.eager });

  // 3. Keep hydrated repos in step with their remotes.
  let scan = await scanWorkspace(root);
  let freshness: FreshnessReport = { repos: [], counts: runFreshnessEmptyCounts() };
  if (doFetch) {
    freshness = await runFreshness(scan.repos, {
      fastForward: doFastForward,
      defaultBranchNames: config.defaultBranchNames,
    });
    // A fast-forward moves HEAD, so re-scan to capture the new commits.
    if (freshness.counts.updated > 0) {
      scan = await scanWorkspace(root);
    }
  }

  // 4. Merge this machine's view into the shared map and publish it.
  let next = (await readWorkspaceMap(paths.mapDir)) ?? emptyWorkspaceMap(scan.rootName);
  next = mergeReposIntoMap(next, scan.repos.map(sharedRepoFromEntry), {
    ignoreFiles: scan.ignoreFiles,
    defaultIgnoreRules: scan.defaultIgnoreRules,
  });
  await writeWorkspaceMap(paths.mapDir, next);
  await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, scan.repos));

  const pushed = await transport.push(
    `sync: ${scan.repos.length} repo(s) from ${identity.hostname}`,
  );

  return { reconciled, freshness, pushed, repoCount: next.repos.length };
}

function runFreshnessEmptyCounts(): FreshnessReport["counts"] {
  return {
    "up-to-date": 0,
    updated: 0,
    behind: 0,
    diverged: 0,
    dirty: 0,
    "fetch-failed": 0,
    "no-upstream": 0,
    detached: 0,
    placeholder: 0,
    skipped: 0,
  };
}
