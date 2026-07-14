import fs from "node:fs/promises";
import path from "node:path";
import { checkoutBranch, cloneRepo, ensureGitAvailable, isGitRepo } from "../core/git";
import { detectShell, hookEvalLine } from "../core/health";
import { readManifest, type RepoEntry } from "../core/manifest";
import { resolveWithinRoot } from "../core/pathUtils";
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

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  logger.heading(`Restore snapshot with placeholders — ${colors.cyan(target)}`);

  let placeholders = 0;
  let skipped = 0;
  let existing = 0;
  let notHydratable = 0;

  for (const repo of repos) {
    const repoPath = resolveWithinRoot(target, repo.relativePath);

    if (isGitRepo(repoPath)) {
      logger.info(`${colors.dim("\u2022")} ${repo.relativePath} is already cloned.`);
      skipped += 1;
      continue;
    }

    if (isPlaceholder(repoPath)) {
      logger.info(`${colors.dim("\u2022")} ${repo.relativePath} already has a placeholder.`);
      existing += 1;
      continue;
    }

    await fs.mkdir(repoPath, { recursive: true });
    const meta = buildPlaceholderMeta(repo);
    await writePlaceholder(repoPath, meta);
    await writePlaceholderReadme(repoPath, meta);

    if (repo.remoteUrl) {
      logger.success(`Prepared placeholder ${repo.relativePath}.`);
    } else {
      logger.warn(`${repo.relativePath} has no remote, so its placeholder cannot clone it.`);
      notHydratable += 1;
    }
    placeholders += 1;
  }

  logger.info();
  logger.success("Snapshot restored.");
  logger.info(`Placeholders prepared: ${placeholders}`);
  logger.info(`Already cloned: ${skipped}`);
  logger.info(`Existing placeholders: ${existing}`);
  logger.info(`Cannot clone because no remote is set: ${notHydratable}`);
  if (placeholders - notHydratable > 0) {
    const first = repos.find(
      (repo) =>
        Boolean(repo.remoteUrl) &&
        isPlaceholder(resolveWithinRoot(target, repo.relativePath)),
    );
    logger.info();
    if (first) {
      logger.next(
        `Clone one now: boot hydrate ${commandArg(
          resolveWithinRoot(target, first.relativePath),
        )}`,
      );
    }
    const shell = detectShell();
    logger.next(
      shell
        ? `Clone placeholders on access after adding: ${hookEvalLine(shell)}`
        : "Set up clone-on-access for your shell: boot shell-hook --help",
    );
  }
}

async function restoreEager(target: string, repos: RepoEntry[]): Promise<void> {
  logger.heading(`Restore snapshot — ${colors.cyan(target)}`);

  let restored = 0;
  let skipped = 0;
  let warnings = 0;

  for (const repo of repos) {
    const repoPath = resolveWithinRoot(target, repo.relativePath);

    // Never overwrite an existing repo.
    if (isGitRepo(repoPath)) {
      logger.info(`${colors.dim("\u2022")} ${repo.relativePath} already exists.`);
      skipped += 1;
      continue;
    }

    await fs.mkdir(path.dirname(repoPath), { recursive: true });

    if (!repo.remoteUrl) {
      await fs.mkdir(repoPath, { recursive: true });
      logger.success(`Created ${repo.relativePath}.`);
      logger.warn(`${repo.name} has no remote, so only its folder was created.`);
      warnings += 1;
      continue;
    }

    try {
      await cloneRepo(repo.remoteUrl, repoPath);
      logger.success(`Cloned ${repo.remoteUrl} into ${repo.relativePath}.`);
    } catch (err) {
      logger.error((err as Error).message);
      warnings += 1;
      continue;
    }

    if (repo.currentBranch) {
      try {
        await checkoutBranch(repoPath, repo.currentBranch);
        logger.success(`Checked out ${repo.currentBranch}.`);
      } catch {
        logger.warn(`Could not check out ${repo.currentBranch} for ${repo.name}.`);
        warnings += 1;
      }
    }

    restored += 1;
  }

  logger.info();
  logger.success("Snapshot restored.");
  logger.info(`Repositories cloned: ${restored}`);
  logger.info(`Existing repositories kept: ${skipped}`);
  logger.info(`Warnings: ${warnings}`);
  logger.next(`Check it: boot status ${commandArg(target)}`);
}
