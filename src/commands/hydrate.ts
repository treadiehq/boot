import path from "node:path";
import { findWorkspaceRoot } from "../core/autohydrate";
import { hydratePlaceholder } from "../core/hydrate";
import { colors, logger } from "../ui/logger";
import { withSpinner } from "../ui/progress";

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function hydrateCommand(repoPath: string): Promise<void> {
  const repoDir = path.resolve(repoPath);
  const label = path.relative(process.cwd(), repoDir) || repoDir;
  const workspaceRoot = findWorkspaceRoot(repoDir);

  let branch: string | null = null;
  const outcome = await withSpinner(`cloning ${label}`, () =>
    hydratePlaceholder(repoDir, {
      onCheckedOut: (b) => {
        branch = b;
      },
    }),
  );

  if (outcome === "already-hydrated") {
    logger.info(`${colors.dim("\u2022")} Repository is already cloned.`);
    return;
  }

  if (branch) logger.info(colors.dim(`  Branch: ${branch}`));
  if (outcome === "hydrated-checkout-failed") {
    logger.warn("Repository cloned, but its saved branch could not be checked out.");
    if (workspaceRoot) {
      logger.next(
        `Check the workspace: boot doctor ${commandArg(workspaceRoot)}`,
      );
    }
    logger.next(`Open the repository and check its branch: cd ${commandArg(repoDir)}`);
    return;
  }
  logger.next(`Open the repository: cd ${commandArg(repoDir)}`);
}
