import type { AheadBehind } from "./git";
import { IGNORE_FILE_NAME } from "./ignore";
import type { PackageManager, ProjectType } from "./projectDetect";

/** Generated folders doctor flags as "should not be synced later" when present. */
export const SUSPICIOUS_GENERATED_DIRS = [
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
] as const;

export interface DoctorRepo {
  name: string;
  relativePath: string;
  status: "local" | "placeholder" | "hydrated";
  dirty: boolean;
  remoteUrl: string | null;
  currentBranch: string | null;
  /** Branch recorded in .boot/repo.json for hydrated placeholders. */
  intendedBranch: string | null;
  /** Whether a hydrated repo's .boot/repo.json exists but could not be parsed. */
  placeholderMetadataInvalid: boolean;
  lastCommitDate: Date | null;
  projectType: ProjectType;
  detectedFiles: string[];
  packageManager: PackageManager | null;
  /** Suspicious generated folders present at the repo top level. */
  presentGeneratedDirs: string[];
  /** Position relative to the upstream tracking ref; null when there is none. */
  aheadBehind: AheadBehind | null;
}

export interface DoctorInput {
  repos: DoctorRepo[];
  hasWorkspaceIgnoreFile: boolean;
  defaultBranchNames: string[];
  staleAfterDays: number;
  /** Reference "now" for staleness checks. Defaults to current time. */
  now?: Date;
}

export interface DoctorReport {
  warnings: string[];
  reposChecked: number;
  placeholdersChecked: number;
  /** Repos whose branch has moved both ahead of and behind its upstream. */
  divergedCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure, synchronous health checks over already-gathered workspace data. */
export function runDoctorChecks(input: DoctorInput): DoctorReport {
  const now = input.now ?? new Date();
  const branches = new Set(input.defaultBranchNames);
  const branchLabel = input.defaultBranchNames.join("/") || "main";
  const warnings: string[] = [];

  let reposChecked = 0;
  let placeholdersChecked = 0;
  let divergedCount = 0;

  if (!input.hasWorkspaceIgnoreFile) {
    warnings.push(`workspace has no ${IGNORE_FILE_NAME}`);
  }

  for (const repo of input.repos) {
    if (repo.placeholderMetadataInvalid) {
      warnings.push(
        `${repo.relativePath}/.boot/repo.json is invalid; placeholder branch checks were skipped`,
      );
    }

    if (repo.status === "placeholder") {
      placeholdersChecked += 1;
      if (!repo.remoteUrl) {
        warnings.push(`${repo.relativePath} is a placeholder with no remote URL`);
      }
      continue;
    }

    reposChecked += 1;

    if (repo.dirty) {
      warnings.push(`${repo.name} is dirty`);
    }
    if (!repo.remoteUrl) {
      warnings.push(`${repo.name} has no remote`);
    }
    if (repo.currentBranch === null) {
      warnings.push(`${repo.name} is in detached HEAD; daemon cannot auto-update it`);
    }
    if (!repo.placeholderMetadataInvalid) {
      if (repo.intendedBranch && repo.currentBranch !== repo.intendedBranch) {
        const current = repo.currentBranch ?? "(detached)";
        warnings.push(
          `${repo.name} is on branch ${current} but was intended to be on ${repo.intendedBranch}`,
        );
      } else if (!repo.intendedBranch && repo.currentBranch && !branches.has(repo.currentBranch)) {
        warnings.push(`${repo.name} is on branch ${repo.currentBranch} instead of ${branchLabel}`);
      }
    }
    // Ahead *and* behind: the daemon can't fast-forward this repo, so it will
    // quietly go stale until the user merges or rebases. Surface it.
    if (repo.aheadBehind && repo.aheadBehind.ahead > 0 && repo.aheadBehind.behind > 0) {
      divergedCount += 1;
      warnings.push(
        `${repo.name} has diverged from its upstream (${repo.aheadBehind.ahead} ahead, ${repo.aheadBehind.behind} behind) — merge or rebase to reconcile`,
      );
    }
    if (repo.currentBranch !== null && repo.remoteUrl !== null && repo.aheadBehind === null) {
      warnings.push(`${repo.name} has no upstream tracking branch; daemon cannot auto-update it`);
    }
    if (repo.lastCommitDate) {
      const ageDays = Math.floor((now.getTime() - repo.lastCommitDate.getTime()) / DAY_MS);
      if (ageDays > input.staleAfterDays) {
        warnings.push(
          `${repo.name} last commit is ${ageDays} days old (stale after ${input.staleAfterDays})`,
        );
      }
    }
    if (
      repo.projectType === "node" &&
      repo.detectedFiles.includes("package.json") &&
      !repo.packageManager
    ) {
      warnings.push(`${repo.name} has a package.json but no lockfile`);
    }
    for (const dir of repo.presentGeneratedDirs) {
      warnings.push(`${repo.name} has ${dir} present; this should not be synced later`);
    }
  }

  return { warnings, reposChecked, placeholdersChecked, divergedCount };
}
