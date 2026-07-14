import type { AheadBehind } from "./git";
import { IGNORE_FILE_NAME } from "./ignore";
import type { PackageManager, ProjectType } from "./projectDetect";
import { quoteUserValue, sanitizeUserText } from "./userErrors";

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
    warnings.push(`workspace has no ${IGNORE_FILE_NAME}; only built-in exclusions apply`);
  }

  for (const repo of input.repos) {
    const name = quoteUserValue(repo.name);
    const relativePath = sanitizeUserText(repo.relativePath, 500);
    if (repo.placeholderMetadataInvalid) {
      warnings.push(
        `${relativePath}/.boot/repo.json is invalid; repository branch checks were skipped. Run \`boot pull\` from the workspace root to recreate it`,
      );
    }

    if (repo.status === "placeholder") {
      placeholdersChecked += 1;
      if (!repo.remoteUrl) {
        warnings.push(
          `${relativePath} is a placeholder with no remote URL; add its URL to boot.yaml before downloading it`,
        );
      }
      continue;
    }

    reposChecked += 1;

    if (repo.dirty) {
      warnings.push(`${name} is dirty (has uncommitted changes)`);
    }
    if (!repo.remoteUrl) {
      warnings.push(`${name} has no repository URL`);
    }
    if (repo.currentBranch === null) {
      warnings.push(`${name} is not on a branch; automatic updates are skipped`);
    }
    if (!repo.placeholderMetadataInvalid) {
      if (repo.intendedBranch && repo.currentBranch !== repo.intendedBranch) {
        const current = repo.currentBranch ? quoteUserValue(repo.currentBranch) : "no branch";
        warnings.push(
          `${name} is on ${current}, but repository download information specifies ${quoteUserValue(repo.intendedBranch)}`,
        );
      } else if (!repo.intendedBranch && repo.currentBranch && !branches.has(repo.currentBranch)) {
        warnings.push(
          `${name} is on branch ${quoteUserValue(repo.currentBranch)} instead of ${quoteUserValue(branchLabel)}`,
        );
      }
    }
    // Ahead *and* behind: the daemon can't fast-forward this repo, so it will
    // quietly go stale until the user merges or rebases. Surface it.
    if (repo.aheadBehind && repo.aheadBehind.ahead > 0 && repo.aheadBehind.behind > 0) {
      divergedCount += 1;
      warnings.push(
        `${name} has diverged from its tracked remote branch (${repo.aheadBehind.ahead} ahead, ${repo.aheadBehind.behind} behind); merge or rebase before automatic updates can continue`,
      );
    }
    if (repo.currentBranch !== null && repo.remoteUrl !== null && repo.aheadBehind === null) {
      warnings.push(
        `${name} has no confirmed upstream tracking branch; automatic updates are skipped`,
      );
    }
    if (repo.lastCommitDate) {
      const ageDays = Math.floor((now.getTime() - repo.lastCommitDate.getTime()) / DAY_MS);
      if (ageDays > input.staleAfterDays) {
        warnings.push(
          `${name} last commit was ${ageDays} days ago (warning threshold: ${input.staleAfterDays} days)`,
        );
      }
    }
    if (
      repo.projectType === "node" &&
      repo.detectedFiles.includes("package.json") &&
      !repo.packageManager
    ) {
      warnings.push(`${name} has a package.json but no lockfile`);
    }
    for (const dir of repo.presentGeneratedDirs) {
      warnings.push(`${name} contains ${quoteUserValue(dir)} at the repository root`);
    }
  }

  return { warnings, reposChecked, placeholdersChecked, divergedCount };
}
