import type { BootstrapResult } from "../core/bootstrap";
import { colors, logger } from "./logger";
import { renderPlan } from "./plan";
import { renderRealizationResult, renderWorkspacePlan } from "./workspace";

export function renderBootstrapResult(result: BootstrapResult): void {
  logger.heading(`Agent workspace — ${colors.cyan(result.root)}`);
  logger.info(
    colors.dim(
      `Source: ${result.source.kind} · ${result.source.state} · Mode: ${result.mode}`,
    ),
  );
  logger.info();

  if (result.mode === "workspace") {
    renderWorkspacePlan(result.plan, result.dryRun);
    if (!result.dryRun) renderRealizationResult(result);
  } else if (result.dryRun) {
    renderPlan(result.reconciliation);
    if (result.hydration.planned.length > 0) {
      logger.info();
      logger.info(
        `Would hydrate ${result.hydration.planned.length} ${
          result.hydration.planned.length === 1 ? "repository" : "repositories"
        }:`,
      );
      for (const repository of result.hydration.planned) {
        logger.info(colors.dim(`  ↓ ${repository}`));
      }
    }
  } else {
    logger.success(
      `Prepared ${result.reconciliation.placeholders} ${
        result.reconciliation.placeholders === 1 ? "placeholder" : "placeholders"
      }.`,
    );
    logger.success(
      `Cloned ${result.reconciliation.cloned + result.hydration.completed.length} ${
        result.reconciliation.cloned + result.hydration.completed.length === 1
          ? "repository"
          : "repositories"
      }.`,
    );
    if (result.environmentFiles > 0) {
      logger.success(
        `Wrote ${result.environmentFiles} ${
          result.environmentFiles === 1 ? ".env file" : ".env files"
        }.`,
      );
    }
    for (const failure of result.failures) {
      logger.error(`${failure.kind} ${failure.name}: ${failure.message}`);
    }
  }

  for (const warning of result.warnings) logger.warn(warning);
  if (!result.dryRun && result.ready) {
    logger.info();
    logger.success("Agent workspace ready.");
  }
}
