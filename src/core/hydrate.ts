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
  type PlaceholderMeta,
} from "./placeholder";
import { quoteUserValue, sanitizeUserText } from "./userErrors";

export type HydrateOutcome = "hydrated" | "hydrated-checkout-failed" | "already-hydrated";

/** Optional callbacks so callers can report progress without the core logging itself. */
export interface HydrateHooks {
  onPlaceholderFound?(meta: PlaceholderMeta): void;
  onCloned?(remoteUrl: string): void;
  onCheckedOut?(branch: string): void;
  onCheckoutFailed?(branch: string): void;
  onUpdated?(): void;
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
      hooks.onPlaceholderFound?.(meta);

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
        await cloneRepo(meta.remoteUrl, clonePath);
        await mergePlaceholderFiles(repoDir, clonePath);
      } catch (err) {
        await fs.rm(stageRoot, { recursive: true, force: true });
        const reason = sanitizeUserText((err as Error).message);
        throw new Error(
          "Could not download the repository; the existing folder was left unchanged." +
            (reason ? ` ${reason}` : "") +
            " Fix the reported problem, then retry.",
        );
      }

      hooks.onCloned?.(meta.remoteUrl);

      await excludePlaceholderFromGit(clonePath);
      await writePlaceholder(clonePath, { ...meta, hydrateStatus: "hydrated" });

      const backupPath = `${repoDir}.boot-backup-${randomBytes(6).toString("hex")}`;
      await fs.rename(repoDir, backupPath);
      try {
        await fs.rename(clonePath, repoDir);
      } catch (error) {
        await fs.rename(backupPath, repoDir).catch(() => undefined);
        await fs.rm(stageRoot, { recursive: true, force: true });
        throw error;
      }
      await fs.rm(backupPath, { recursive: true, force: true });
      await fs.rm(stageRoot, { recursive: true, force: true });

      let checkoutFailed = false;
      if (meta.branch) {
        try {
          await checkoutBranch(repoDir, meta.branch);
          hooks.onCheckedOut?.(meta.branch);
        } catch {
          checkoutFailed = true;
          hooks.onCheckoutFailed?.(meta.branch);
        }
      }
      hooks.onUpdated?.();

      return checkoutFailed ? "hydrated-checkout-failed" : "hydrated";
    },
  );
}
