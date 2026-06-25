import { existsSync } from "node:fs";
import path from "node:path";
import { ensureGitAvailable, getLastCommitDate } from "../core/git";
import { runDoctorChecks, SUSPICIOUS_GENERATED_DIRS, type DoctorRepo } from "../core/doctor";
import { collectHealth } from "../core/health";
import { scanWorkspace } from "../core/scanner";
import { colors, logger } from "../ui/logger";
import { renderSetupHealth } from "../ui/health";

function presentGeneratedDirs(repoAbsPath: string): string[] {
  return SUSPICIOUS_GENERATED_DIRS.filter((dir) => existsSync(path.join(repoAbsPath, dir)));
}

export interface DoctorOptions {
  /** Check boot's own wiring (link/key/hook/daemon/FUSE) instead of repo health. */
  system?: boolean;
}

export async function doctorCommand(
  workspacePath: string,
  options: DoctorOptions = {},
): Promise<void> {
  if (options.system) {
    const health = await collectHealth(path.resolve(workspacePath));
    renderSetupHealth(health);
    return;
  }

  await ensureGitAvailable();

  const result = await scanWorkspace(workspacePath);

  // Enrich each repo with the extra data the checks need (commit dates +
  // generated folders). Placeholders skip git/fs lookups.
  const repos: DoctorRepo[] = await Promise.all(
    result.repos.map(async (repo) => {
      const isPlaceholder = repo.hydrate.status === "placeholder";
      const lastCommitDate = isPlaceholder ? null : await getLastCommitDate(repo.absolutePath);
      return {
        name: repo.name,
        relativePath: repo.relativePath,
        status: repo.hydrate.status,
        dirty: repo.dirty,
        remoteUrl: repo.remoteUrl,
        currentBranch: repo.currentBranch,
        lastCommitDate,
        projectType: repo.projectType,
        detectedFiles: repo.detectedFiles,
        packageManager: repo.packageManager,
        presentGeneratedDirs: isPlaceholder ? [] : presentGeneratedDirs(repo.absolutePath),
      };
    }),
  );

  const report = runDoctorChecks({
    repos,
    hasWorkspaceIgnoreFile: result.hasWorkspaceIgnoreFile,
    defaultBranchNames: result.config.defaultBranchNames,
    staleAfterDays: result.config.staleAfterDays,
  });

  logger.heading("boot Doctor");
  logger.info(`Workspace: ${colors.cyan(result.rootName)}`);

  if (report.warnings.length === 0) {
    logger.success("no issues found");
  } else {
    logger.info(colors.bold("Warnings:"));
    for (const warning of report.warnings) {
      logger.warn(warning);
    }
  }

  logger.info(colors.bold("Summary:"));
  logger.info(`Repos checked: ${report.reposChecked}`);
  logger.info(`Placeholders checked: ${report.placeholdersChecked}`);
  logger.info(`Warnings: ${report.warnings.length}`);
}
