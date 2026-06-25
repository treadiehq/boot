import fs from "node:fs/promises";
import path from "node:path";
import { checkoutBranch, cloneRepo, ensureGitAvailable, isGitRepo } from "../core/git";
import { readManifest, type RepoEntry } from "../core/manifest";
import {
  buildPlaceholderMeta,
  isPlaceholder,
  writePlaceholder,
  writePlaceholderReadme,
} from "../core/placeholder";
import { colors, logger } from "../ui/logger";

export interface RestoreOptions {
  lazy?: boolean;
}

export async function restoreCommand(
  manifestPath: string,
  targetPath: string,
  options: RestoreOptions = {},
): Promise<void> {
  if (!options.lazy) {
    await ensureGitAvailable();
  }

  const manifest = await readManifest(manifestPath);
  const target = path.resolve(targetPath);
  await fs.mkdir(target, { recursive: true });

  // Restore in path order so parent folders are created before their children.
  const repos = [...manifest.repos].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (options.lazy) {
    await restoreLazy(target, repos);
    return;
  }
  await restoreEager(target, repos);
}

async function restoreLazy(target: string, repos: RepoEntry[]): Promise<void> {
  logger.heading(`Restoring workspace (lazy) to ${colors.cyan(target)}`);

  let placeholders = 0;
  let skipped = 0;
  let existing = 0;
  let notHydratable = 0;

  for (const repo of repos) {
    const repoPath = path.join(target, repo.relativePath);

    if (isGitRepo(repoPath)) {
      logger.info(`${colors.dim("\u2022")} ${repo.relativePath} already hydrated`);
      skipped += 1;
      continue;
    }

    if (isPlaceholder(repoPath)) {
      logger.info(`${colors.dim("\u2022")} ${repo.relativePath} placeholder already exists`);
      existing += 1;
      continue;
    }

    await fs.mkdir(repoPath, { recursive: true });
    const meta = buildPlaceholderMeta(repo);
    await writePlaceholder(repoPath, meta);
    await writePlaceholderReadme(repoPath, meta);

    if (repo.remoteUrl) {
      logger.success(`placeholder ${repo.relativePath}`);
    } else {
      logger.warn(`${repo.relativePath} has no remote — placeholder is not hydratable`);
      notHydratable += 1;
    }
    placeholders += 1;
  }

  logger.info();
  logger.success("Lazy restore complete.");
  logger.info(`Placeholders created: ${placeholders}`);
  logger.info(`Already hydrated: ${skipped}`);
  logger.info(`Existing placeholders: ${existing}`);
  logger.info(`Not hydratable (no remote): ${notHydratable}`);
  if (placeholders - notHydratable > 0) {
    logger.info();
    logger.next("Hydrate one now:  boot hydrate <relativePath>");
    logger.next('Or hydrate on access:  eval "$(boot shell-hook zsh)"');
  }
}

async function restoreEager(target: string, repos: RepoEntry[]): Promise<void> {
  logger.heading(`Restoring workspace to ${colors.cyan(target)}`);

  let restored = 0;
  let skipped = 0;
  let warnings = 0;

  for (const repo of repos) {
    const repoPath = path.join(target, repo.relativePath);

    // Never overwrite an existing repo.
    if (isGitRepo(repoPath)) {
      logger.info(`${colors.dim("\u2022")} ${repo.relativePath} already exists`);
      skipped += 1;
      continue;
    }

    await fs.mkdir(path.dirname(repoPath), { recursive: true });

    if (!repo.remoteUrl) {
      await fs.mkdir(repoPath, { recursive: true });
      logger.success(`created ${repo.relativePath}`);
      logger.warn(`${repo.name} has no remote — created folder, cannot clone`);
      warnings += 1;
      continue;
    }

    logger.success(`created ${repo.relativePath}`);

    try {
      await cloneRepo(repo.remoteUrl, repoPath);
      logger.success(`cloned ${repo.remoteUrl}`);
    } catch (err) {
      logger.error((err as Error).message);
      warnings += 1;
      continue;
    }

    if (repo.currentBranch) {
      try {
        await checkoutBranch(repoPath, repo.currentBranch);
        logger.success(`checked out ${repo.currentBranch}`);
      } catch {
        logger.warn(`could not checkout ${repo.currentBranch} for ${repo.name}`);
        warnings += 1;
      }
    }

    restored += 1;
  }

  logger.info();
  logger.success("Restore complete.");
  logger.info(`Repos restored: ${restored}`);
  logger.info(`Skipped existing repos: ${skipped}`);
  logger.info(`Warnings: ${warnings}`);
  logger.next(`Inspect it:  boot status ${path.relative(process.cwd(), target) || "."}`);
}
