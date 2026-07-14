import path from "node:path";
import { autoHydrate, findWorkspaceRoot } from "../core/autohydrate";
import { colors, logger } from "../ui/logger";

export interface EnterOptions {
  /** Suppress all output (used by the shell hook). */
  quiet?: boolean;
}

/**
 * Materialise the part of the workspace you just navigated into. Resolves the
 * nearest placeholder at or above `targetPath` and hydrates it. Designed to be
 * cheap and silent so a shell `cd` hook can call it on every directory change —
 * if there's nothing to hydrate, it does nothing.
 */
export async function enterCommand(targetPath = ".", options: EnterOptions = {}): Promise<void> {
  const accessed = path.resolve(targetPath);
  const root = findWorkspaceRoot(accessed);
  const stopAt = root ?? path.parse(accessed).root;

  const result = await autoHydrate(accessed, { stopAt });

  if (options.quiet) return;

  if (result.hydrated && result.repoDir) {
    const label = root ? path.relative(root, result.repoDir) : result.repoDir;
    logger.success(`cloned ${colors.cyan(label || ".")}`);
  } else {
    logger.info(colors.dim("No repository placeholder found."));
  }
}
