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
  lastCommitDate: Date | null;
  projectType: ProjectType;
  detectedFiles: string[];
  packageManager: PackageManager | null;
  /** Suspicious generated folders present at the repo top level. */
  presentGeneratedDirs: string[];
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

  if (!input.hasWorkspaceIgnoreFile) {
    warnings.push(`workspace has no ${IGNORE_FILE_NAME}`);
  }

  for (const repo of input.repos) {
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
    if (repo.currentBranch && !branches.has(repo.currentBranch)) {
      warnings.push(`${repo.name} is on branch ${repo.currentBranch} instead of ${branchLabel}`);
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

  return { warnings, reposChecked, placeholdersChecked };
}
