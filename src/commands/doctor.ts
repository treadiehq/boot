import { existsSync } from "node:fs";
import path from "node:path";
import { ensureGitAvailable, getLastCommitDate, gitAheadBehind } from "../core/git";
import { runDoctorChecks, SUSPICIOUS_GENERATED_DIRS, type DoctorRepo } from "../core/doctor";
import { collectHealth } from "../core/health";
import { readPlaceholder } from "../core/placeholder";
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

  // Enrich each repo with the extra data the checks need (commit dates,
  // upstream position + generated folders). Placeholders skip git/fs lookups.
  // Ahead/behind reads already-fetched refs (no network) — the daemon keeps
  // them current, and doctor should stay fast and offline-safe.
  const repos: DoctorRepo[] = await Promise.all(
    result.repos.map(async (repo) => {
      const isPlaceholder = repo.hydrate.status === "placeholder";
      const isHydratedPlaceholder = repo.hydrate.status === "hydrated";
      const placeholderRead = isHydratedPlaceholder
        ? readPlaceholder(repo.absolutePath)
            .then((meta) => ({ meta, invalid: false }))
            .catch(() => ({ meta: null, invalid: true }))
        : Promise.resolve({ meta: null, invalid: false });
      const [lastCommitDate, aheadBehind, placeholder] = isPlaceholder
        ? [null, null, { meta: null, invalid: false }]
        : await Promise.all([
            getLastCommitDate(repo.absolutePath),
            gitAheadBehind(repo.absolutePath),
            placeholderRead,
          ]);
      return {
        name: repo.name,
        relativePath: repo.relativePath,
        status: repo.hydrate.status,
        dirty: repo.dirty,
        remoteUrl: repo.remoteUrl,
        currentBranch: repo.currentBranch,
        intendedBranch: placeholder.meta?.branch ?? null,
        placeholderMetadataInvalid: placeholder.invalid,
        lastCommitDate,
        projectType: repo.projectType,
        detectedFiles: repo.detectedFiles,
        packageManager: repo.packageManager,
        presentGeneratedDirs: isPlaceholder ? [] : presentGeneratedDirs(repo.absolutePath),
        aheadBehind,
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
  logger.info(`Diverged from upstream: ${report.divergedCount}`);
  logger.info(`Warnings: ${report.warnings.length}`);
}
