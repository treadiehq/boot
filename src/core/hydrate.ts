import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkoutBranch, cloneRepo, ensureGitAvailable, isGitRepo } from "./git";
import {
  excludePlaceholderFromGit,
  readPlaceholder,
  writePlaceholder,
  type PlaceholderMeta,
} from "./placeholder";

export type HydrateOutcome = "hydrated" | "already-hydrated";

/** Optional callbacks so callers can report progress without the core logging itself. */
export interface HydrateHooks {
  onPlaceholderFound?(meta: PlaceholderMeta): void;
  onCloned?(remoteUrl: string): void;
  onCheckedOut?(branch: string): void;
  onCheckoutFailed?(branch: string): void;
  onUpdated?(): void;
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

  const label = path.relative(process.cwd(), repoDir) || repoDir;
  const meta = await readPlaceholder(repoDir);
  if (!meta) {
    throw new Error(
      `${label} is not a boot placeholder (missing .boot/repo.json). ` +
        `Run \`boot pull\` or \`boot restore <manifest> <target> --lazy\` first.`,
    );
  }
  hooks.onPlaceholderFound?.(meta);

  if (!meta.remoteUrl) {
    throw new Error(
      `${meta.name} has no remote URL recorded — this placeholder is not hydratable.`,
    );
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "boot-hydrate-"));
  const clonePath = path.join(tmpRoot, "clone");

  try {
    await cloneRepo(meta.remoteUrl, clonePath);
    // Move the cloned contents into the placeholder folder. The existing
    // `.boot/` directory is preserved (the clone has no such folder).
    await fs.cp(clonePath, repoDir, { recursive: true });
  } catch (err) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    // Placeholder is left intact for a retry.
    throw new Error(`Clone failed; placeholder left intact. ${(err as Error).message}`);
  }

  await fs.rm(tmpRoot, { recursive: true, force: true });
  hooks.onCloned?.(meta.remoteUrl);

  if (meta.branch) {
    try {
      await checkoutBranch(repoDir, meta.branch);
      hooks.onCheckedOut?.(meta.branch);
    } catch {
      hooks.onCheckoutFailed?.(meta.branch);
    }
  }

  // Keep the hydrated repo clean: the preserved .boot/ folder is untracked.
  await excludePlaceholderFromGit(repoDir);
  await writePlaceholder(repoDir, { ...meta, hydrateStatus: "hydrated" });
  hooks.onUpdated?.();

  return "hydrated";
}
