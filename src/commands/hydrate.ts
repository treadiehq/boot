import path from "node:path";
import { hydratePlaceholder } from "../core/hydrate";
import { colors, logger } from "../ui/logger";
import { withSpinner } from "../ui/progress";

export async function hydrateCommand(repoPath: string): Promise<void> {
  const repoDir = path.resolve(repoPath);
  const label = path.relative(process.cwd(), repoDir) || repoDir;

  let branch: string | null = null;
  const outcome = await withSpinner(`hydrating ${label}`, () =>
    hydratePlaceholder(repoDir, {
      onCheckedOut: (b) => {
        branch = b;
      },
    }),
  );

  if (outcome === "already-hydrated") {
    logger.info(`${colors.dim("\u2022")} already hydrated`);
    return;
  }

  if (branch) logger.info(colors.dim(`  on ${branch}`));
  if (outcome === "hydrated-checkout-failed") {
    logger.warn("could not checkout the recorded branch; repo is on the clone default branch");
    logger.next(`cd ${label}, check the branch, and run \`boot doctor\` for details.`);
    return;
  }
  logger.next(`cd ${label} and start working.`);
}
