import fs from "node:fs/promises";
import path from "node:path";
import { checkoutBranch, cloneRepo, isGitRepo } from "./git";
import {
  buildPlaceholderMeta,
  isPlaceholder,
  writePlaceholder,
  writePlaceholderReadme,
} from "./placeholder";
import type { SharedRepo } from "./map";

export type ReconcileAction = "clone" | "placeholder";

export interface ReconcileItem {
  relativePath: string;
  action: ReconcileAction;
}

export interface ReconcileHooks {
  /** Called before each repo is materialised (real runs only). */
  onItem?: (info: { index: number; total: number } & ReconcileItem) => void;
  /** Called after each repo, with elapsed time and the action actually taken. */
  onItemDone?: (
    info: { index: number; total: number; ms: number } & ReconcileItem,
  ) => void;
}

export interface ReconcileOptions {
  /** Clone repos outright instead of writing placeholders. */
  eager?: boolean;
  /** Compute the plan without touching the filesystem. */
  dryRun?: boolean;
  /** Per-item progress callbacks (ignored for dry runs). */
  hooks?: ReconcileHooks;
}

export interface ReconcileResult {
  placeholders: number;
  cloned: number;
  /** Repos already present locally (real repo or existing placeholder). */
  skipped: number;
  /** What would be / was created, in apply order. */
  plan: ReconcileItem[];
}

/** Repos in the map that aren't present locally yet, with their intended action. */
function planReconcile(root: string, repos: SharedRepo[], eager: boolean): {
  plan: Array<{ repo: SharedRepo; action: ReconcileAction }>;
  skipped: number;
} {
  // Sort by path so parent folders are created before their children.
  const sorted = [...repos].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const plan: Array<{ repo: SharedRepo; action: ReconcileAction }> = [];
  let skipped = 0;

  for (const repo of sorted) {
    const repoPath = path.join(root, repo.relativePath);
    if (isGitRepo(repoPath) || isPlaceholder(repoPath)) {
      skipped += 1;
      continue;
    }
    plan.push({ repo, action: eager && repo.remoteUrl ? "clone" : "placeholder" });
  }
  return { plan, skipped };
}

/**
 * Recreate any structure described by the map that is missing on this machine.
 * By default this writes lightweight placeholders (the lazy model); `eager`
 * clones instead, falling back to a placeholder if the clone fails. Existing
 * repos and placeholders are never touched. Pass `dryRun` to get the plan
 * without writing anything.
 */
export async function reconcileFromMap(
  root: string,
  repos: SharedRepo[],
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const eager = Boolean(options.eager);
  const { plan, skipped } = planReconcile(root, repos, eager);

  const result: ReconcileResult = {
    placeholders: 0,
    cloned: 0,
    skipped,
    plan: plan.map(({ repo, action }) => ({ relativePath: repo.relativePath, action })),
  };

  if (options.dryRun) {
    result.placeholders = plan.filter((p) => p.action === "placeholder").length;
    result.cloned = plan.filter((p) => p.action === "clone").length;
    return result;
  }

  const total = plan.length;
  for (let i = 0; i < total; i += 1) {
    const { repo, action } = plan[i]!;
    const repoPath = path.join(root, repo.relativePath);
    const index = i + 1;
    options.hooks?.onItem?.({ index, total, relativePath: repo.relativePath, action });
    const started = Date.now();
    let taken: ReconcileAction = action;

    if (action === "clone" && repo.remoteUrl) {
      await fs.mkdir(path.dirname(repoPath), { recursive: true });
      try {
        await cloneRepo(repo.remoteUrl, repoPath);
        if (repo.branch) {
          await checkoutBranch(repoPath, repo.branch).catch(() => undefined);
        }
        result.cloned += 1;
        options.hooks?.onItemDone?.({
          index,
          total,
          ms: Date.now() - started,
          relativePath: repo.relativePath,
          action: "clone",
        });
        continue;
      } catch {
        // Clone failed — fall through and leave a placeholder for a later retry.
        taken = "placeholder";
      }
    }

    await fs.mkdir(repoPath, { recursive: true });
    const meta = buildPlaceholderMeta({
      name: repo.name,
      relativePath: repo.relativePath,
      remoteUrl: repo.remoteUrl,
      currentBranch: repo.branch,
      lastCommit: repo.lastCommit,
    });
    await writePlaceholder(repoPath, meta);
    await writePlaceholderReadme(repoPath, meta);
    result.placeholders += 1;
    options.hooks?.onItemDone?.({
      index,
      total,
      ms: Date.now() - started,
      relativePath: repo.relativePath,
      action: taken,
    });
  }

  return result;
}
