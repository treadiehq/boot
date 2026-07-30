import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkoutBranch, cloneRepo, ensureGitAvailable, isGitRepo } from "./git";
import { withFileLock } from "./lock";
import {
  excludePlaceholderFromGit,
  PLACEHOLDER_DIR,
  readPlaceholder,
  writePlaceholder,
} from "./placeholder";
import { quoteUserValue, sanitizeUserText } from "./userErrors";

export type HydrateOutcome = "hydrated" | "hydrated-checkout-failed" | "already-hydrated";

/** Optional callbacks so callers can report progress without the core logging itself. */
export interface HydrateHooks {
  onCheckedOut?(branch: string): void;
}

function hydrationLockPath(repoDir: string): string {
  return path.join(path.dirname(repoDir), `.${path.basename(repoDir)}.boot-hydrate.lock`);
}

async function mergePlaceholderFiles(repoDir: string, clonePath: string): Promise<void> {
  const entries = await fs.readdir(repoDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(repoDir, entry.name);
    const target = path.join(clonePath, entry.name);
    if (entry.name === PLACEHOLDER_DIR) {
      await fs.cp(source, target, { recursive: true });
      continue;
    }
    const collision = await fs.stat(target).catch(() => null);
    if (collision) {
      throw new Error(
        `Could not preserve ${quoteUserValue(entry.name)} because the downloaded repository contains the same path. Move or remove the existing item, then retry.`,
      );
    }
    await fs.cp(source, target, { recursive: true });
  }
}

function stagedHydrationError(
  summary: string,
  error: unknown,
): Error {
  const reason = sanitizeUserText((error as Error).message);
  return new Error(
    summary +
      (reason ? ` ${reason}` : "") +
      " Fix the reported problem, then retry.",
  );
}

/**
 * Clone a placeholder's real repo into its folder, in place. The cloned content
 * is moved in around the preserved `.boot/` metadata, the recorded branch is
 * checked out, and the placeholder is marked hydrated. Never overwrites an
 * existing repo; leaves the placeholder intact if the clone fails.
 *
 * Throws when the folder is not a placeholder or has no recorded remote.
 */
export async function hydratePlaceholder(
  repoDir: string,
  hooks: HydrateHooks = {},
): Promise<HydrateOutcome> {
  await ensureGitAvailable();

  // Already a real repo — never overwrite.
  if (isGitRepo(repoDir)) return "already-hydrated";

  return withFileLock(
    hydrationLockPath(repoDir),
    `downloading ${quoteUserValue(repoDir, 500)}`,
    async () => {
      // Another process may have completed while this process waited.
      if (isGitRepo(repoDir)) return "already-hydrated";

      const label = path.relative(process.cwd(), repoDir) || repoDir;
      const meta = await readPlaceholder(repoDir);
      if (!meta) {
        throw new Error(
          `${quoteUserValue(label, 500)} does not contain repository download information (.boot/repo.json). Run \`boot pull\` from the workspace root to recreate it.`,
        );
      }
      if (!meta.remoteUrl) {
        throw new Error(
          `Repository ${quoteUserValue(meta.name)} has no URL, so it cannot be downloaded. Add its URL to \`boot.yaml\`, then run \`boot up .\` from the workspace root.`,
        );
      }

      const parent = path.dirname(repoDir);
      const stageRoot = await fs.mkdtemp(
        path.join(parent, `.${path.basename(repoDir)}.boot-stage-`),
      );
      const clonePath = path.join(stageRoot, "clone");

      try {
        try {
          await cloneRepo(meta.remoteUrl, clonePath);
        } catch (error) {
          throw stagedHydrationError(
            "Could not download the repository; the existing folder was left unchanged.",
            error,
          );
        }

        try {
          await mergePlaceholderFiles(repoDir, clonePath);
        } catch (error) {
          throw stagedHydrationError(
            "The repository was downloaded, but Boot could not preserve the existing placeholder files; the existing folder was left unchanged.",
            error,
          );
        }

        try {
          await excludePlaceholderFromGit(clonePath);
          await writePlaceholder(clonePath, { ...meta, hydrateStatus: "hydrated" });
        } catch (error) {
          throw stagedHydrationError(
            "The repository was downloaded, but Boot could not update its placeholder metadata; the existing folder was left unchanged.",
            error,
          );
        }

        const backupPath = `${repoDir}.boot-backup-${randomBytes(6).toString("hex")}`;
        try {
          await fs.rename(repoDir, backupPath);
        } catch (error) {
          throw stagedHydrationError(
            "The repository was downloaded, but Boot could not prepare the existing placeholder for replacement; the existing folder was left unchanged.",
            error,
          );
        }
        try {
          await fs.rename(clonePath, repoDir);
        } catch (error) {
          await fs.rename(backupPath, repoDir).catch(() => undefined);
          throw error;
        }
        await fs.rm(backupPath, { recursive: true, force: true });
      } finally {
        await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
      }

      let checkoutFailed = false;
      if (meta.branch) {
        try {
          await checkoutBranch(repoDir, meta.branch);
          hooks.onCheckedOut?.(meta.branch);
        } catch {
          checkoutFailed = true;
        }
      }

      return checkoutFailed ? "hydrated-checkout-failed" : "hydrated";
    },
  );
}
