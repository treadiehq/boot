import {
  gitAheadBehind,
  gitFastForwardOnly,
  gitFetch,
  gitUpstreamRef,
  isDirty,
  isGitRepo,
} from "./git";
import type { RepoEntry } from "./manifest";

/** Outcome of assessing (and possibly updating) a single repo's freshness. */
export type FreshnessStatus =
  | "up-to-date" // local matches or leads its upstream
  | "updated" // was behind, fast-forwarded to the upstream
  | "behind" // behind the upstream but not auto-advanced (not a default branch, etc.)
  | "diverged" // local and upstream have both moved — needs a manual merge/rebase
  | "dirty" // uncommitted changes, left untouched
  | "fetch-failed" // could not refresh upstream refs
  | "no-upstream" // branch has no tracking ref
  | "detached" // not on a branch
  | "placeholder" // not hydrated yet — nothing to do
  | "skipped"; // not a git repo / fetch unavailable

export interface RepoFreshness {
  relativePath: string;
  status: FreshnessStatus;
  ahead: number;
  behind: number;
}

export interface FreshnessReport {
  repos: RepoFreshness[];
  counts: Record<FreshnessStatus, number>;
}

export interface FreshnessOptions {
  /** Fast-forward clean repos that are behind. Defaults to true. */
  fastForward?: boolean;
  /** Branch names eligible for automatic fast-forward. Defaults to ["main", "master"]. */
  defaultBranchNames?: string[];
  /** Skip network fetches and assess against already-known refs. Defaults to false. */
  skipFetch?: boolean;
}

function emptyCounts(): Record<FreshnessStatus, number> {
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

async function assessRepo(
  repo: RepoEntry,
  options: Required<Pick<FreshnessOptions, "fastForward" | "defaultBranchNames" | "skipFetch">>,
): Promise<FreshnessStatus> {
  if (repo.hydrate.status === "placeholder") return "placeholder";

  const dir = repo.absolutePath;
  if (!isGitRepo(dir)) return "skipped";
  if (!repo.currentBranch) return "detached";

  if (!options.skipFetch) {
    const fetched = await gitFetch(dir);
    if (!fetched) return "fetch-failed";
  }

  const upstream = await gitUpstreamRef(dir);
  if (!upstream) return "no-upstream";

  const counts = await gitAheadBehind(dir);
  if (!counts) return "no-upstream";

  if (counts.behind === 0) return "up-to-date";
  if (counts.ahead > 0) return "diverged";

  // Behind with no local commits ahead — a fast-forward is safe, but only when
  // the working tree is clean. Check live (not the scan snapshot) to avoid
  // advancing a repo someone is mid-edit on.
  if (await isDirty(dir)) return "dirty";

  const eligible = options.defaultBranchNames.includes(repo.currentBranch);
  if (options.fastForward && eligible) {
    return (await gitFastForwardOnly(dir)) ? "updated" : "behind";
  }
  return "behind";
}

/**
 * Assess (and, where safe, fast-forward) every hydrated repo in a workspace.
 * Only clean repos on a default branch with no local-only commits are advanced;
 * everything else is reported, never silently changed. This is the daemon's
 * answer to "I forgot to pull latest main before building".
 */
export async function runFreshness(
  repos: RepoEntry[],
  options: FreshnessOptions = {},
): Promise<FreshnessReport> {
  const resolved = {
    fastForward: options.fastForward ?? true,
    defaultBranchNames: options.defaultBranchNames ?? ["main", "master"],
    skipFetch: options.skipFetch ?? false,
  };

  const results: RepoFreshness[] = [];
  const counts = emptyCounts();

  for (const repo of repos) {
    const status = await assessRepo(repo, resolved);
    // Re-read counts for reporting (cheap, and reflects any fast-forward).
    let ahead = 0;
    let behind = 0;
    if (
      status !== "fetch-failed" &&
      isGitRepo(repo.absolutePath) &&
      repo.hydrate.status !== "placeholder"
    ) {
      const ab = await gitAheadBehind(repo.absolutePath);
      if (ab) {
        ahead = ab.ahead;
        behind = ab.behind;
      }
    }
    results.push({ relativePath: repo.relativePath, status, ahead, behind });
    counts[status] += 1;
  }

  return { repos: results, counts };
}
