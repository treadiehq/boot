import { ensureGitAvailable } from "../core/git";
import { scanWorkspace } from "../core/scanner";
import { colors, logger } from "../ui/logger";

export async function statusCommand(workspacePath: string): Promise<void> {
  await ensureGitAvailable();

  const result = await scanWorkspace(workspacePath);

  const hydrated = result.repos.filter((r) => r.hydrate.status !== "placeholder");
  const placeholders = result.repos.filter((r) => r.hydrate.status === "placeholder");
  const dirtyCount = hydrated.filter((r) => r.dirty).length;

  logger.heading("boot Status");

  // Column widths shared across hydrated + placeholder rows for alignment.
  const allRows = [...hydrated, ...placeholders];
  const pathW = Math.max(4, ...allRows.map((r) => r.relativePath.length));
  const branchW = Math.max(6, ...allRows.map((r) => (r.currentBranch ?? "no remote").length));

  logger.info(colors.bold("Hydrated:"));
  if (hydrated.length === 0) {
    logger.info(colors.dim("  (none)"));
  }
  for (const repo of hydrated) {
    const branch = repo.currentBranch ?? "(detached)";
    const state = repo.dirty ? colors.yellow("dirty") : colors.green("clean");
    logger.info(
      `${colors.green("\u2713")} ${repo.relativePath.padEnd(pathW)}  ${branch.padEnd(branchW)}  ${state}`,
    );
  }

  logger.info(colors.bold("Placeholders:"));
  if (placeholders.length === 0) {
    logger.info(colors.dim("  (none)"));
  }
  for (const repo of placeholders) {
    const hydratable = Boolean(repo.remoteUrl);
    const branch = hydratable ? repo.currentBranch ?? "(unknown)" : "no remote";
    const note = hydratable ? colors.dim("not hydrated") : colors.yellow("not hydratable");
    logger.info(`${colors.dim("\u25cb")} ${repo.relativePath.padEnd(pathW)}  ${branch.padEnd(branchW)}  ${note}`);
  }

  if (result.otherFolders.length > 0) {
    logger.info(colors.bold("Other folders:"));
    for (const folder of result.otherFolders) {
      logger.info(`${colors.dim("-")} ${folder}`);
    }
  }

  logger.info(colors.bold("Summary:"));
  logger.info(`Hydrated repos: ${hydrated.length}`);
  logger.info(`Placeholders: ${placeholders.length}`);
  logger.info(`Dirty repos: ${dirtyCount}`);
  logger.info(`Other folders: ${result.otherFolders.length}`);
}
