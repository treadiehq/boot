import type { ReconcileHooks, ReconcileResult } from "../core/reconcile";
import { colors, logger } from "./logger";
import { fmtMs, stepPrefix } from "./progress";

/** Print a dry-run reconcile plan: what would be created, and what's skipped. */
export function renderPlan(result: ReconcileResult): void {
  const clones = result.plan.filter((p) => p.action === "clone");
  const placeholders = result.plan.filter((p) => p.action === "placeholder");

  if (result.plan.length === 0) {
    logger.info(colors.dim("All known repositories are already present."));
  } else {
    if (placeholders.length > 0) {
      logger.info(
        `Would prepare ${colors.bold(String(placeholders.length))} repository ${
          placeholders.length === 1 ? "placeholder" : "placeholders"
        } (each clones on first use):`,
      );
      for (const p of placeholders) logger.info(colors.dim(`  + ${p.relativePath}`));
    }
    if (clones.length > 0) {
      logger.info(
        `Would clone ${colors.bold(String(clones.length))} ${
          clones.length === 1 ? "repository" : "repositories"
        }:`,
      );
      for (const p of clones) logger.info(colors.dim(`  \u2193 ${p.relativePath}`));
    }
  }
  if (result.skipped > 0) {
    logger.info(
      colors.dim(
        `(${result.skipped} ${result.skipped === 1 ? "repository" : "repositories"} already present)`,
      ),
    );
  }
  logger.next("Re-run without --dry-run to prepare the workspace.");
}

/** Progress hooks that print a `[i/n]` line as each repo is materialised. */
export function reconcileProgressHooks(): ReconcileHooks {
  return {
    onItemDone: ({ index, total, ms, relativePath, action }) => {
      const verb = action === "clone" ? "cloned" : "prepared";
      logger.info(
        `${stepPrefix(index, total)} ${verb} ${colors.cyan(relativePath)} ${colors.dim(`(${fmtMs(ms)})`)}`,
      );
    },
  };
}
