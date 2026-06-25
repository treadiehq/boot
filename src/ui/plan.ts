import type { ReconcileHooks, ReconcileResult } from "../core/reconcile";
import { colors, logger } from "./logger";
import { fmtMs, stepPrefix } from "./progress";

/** Print a dry-run reconcile plan: what would be created, and what's skipped. */
export function renderPlan(result: ReconcileResult): void {
  const clones = result.plan.filter((p) => p.action === "clone");
  const placeholders = result.plan.filter((p) => p.action === "placeholder");

  if (result.plan.length === 0) {
    logger.info(colors.dim("Nothing to create — already in sync."));
  } else {
    if (placeholders.length > 0) {
      logger.info(`Would create ${colors.bold(String(placeholders.length))} placeholder(s):`);
      for (const p of placeholders) logger.info(colors.dim(`  + ${p.relativePath}`));
    }
    if (clones.length > 0) {
      logger.info(`Would clone ${colors.bold(String(clones.length))} repo(s):`);
      for (const p of clones) logger.info(colors.dim(`  \u2193 ${p.relativePath}`));
    }
  }
  logger.info(colors.dim(`(${result.skipped} already present)`));
  logger.next("Re-run without --dry-run to apply.");
}

/** Progress hooks that print a `[i/n]` line as each repo is materialised. */
export function reconcileProgressHooks(): ReconcileHooks {
  return {
    onItemDone: ({ index, total, ms, relativePath, action }) => {
      const verb = action === "clone" ? "cloned" : "placeholder";
      logger.info(
        `${stepPrefix(index, total)} ${verb} ${colors.cyan(relativePath)} ${colors.dim(`(${fmtMs(ms)})`)}`,
      );
    },
  };
}
