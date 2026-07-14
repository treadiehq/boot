import type {
  RealizationPlan,
  RealizationResult,
  RepositoryPlan,
} from "../core/provider";
import type { RequirementStatus } from "../core/requirements";
import { colors, logger } from "./logger";

function repositoryLabel(repository: RepositoryPlan): string {
  const role = repository.role ? colors.dim(` — ${repository.role}`) : "";
  return `${colors.cyan(repository.id)} ${colors.dim(`(${repository.path})`)}${role}`;
}

function repositoryVerb(repository: RepositoryPlan): string {
  switch (repository.action) {
    case "clone":
      return "clone";
    case "placeholder":
      return "create placeholder (repository not cloned)";
    case "hydrate":
      return "clone placeholder";
    case "update-placeholder":
      return "update placeholder";
    case "checkout":
      return `check out ${repository.ref}`;
    case "conflict":
      return `blocked: ${repository.detail ?? "conflicting local state"}`;
    default:
      return repository.state === "placeholder"
        ? "placeholder (repository not cloned)"
        : "ready";
  }
}

function environmentSource(source: string | undefined): string {
  if (source === "process") return "the current environment";
  if (source === "boot") return "Boot's encrypted storage";
  return "a configured source";
}

function renderRequirement(label: string, requirement: RequirementStatus): void {
  const version = requirement.required ? ` ${requirement.required}` : "";
  const observed = requirement.observed ? colors.dim(` — ${requirement.observed}`) : "";
  if (requirement.state === "available") {
    logger.success(`${label} ${colors.cyan(requirement.name)}${version}${observed}`);
  } else {
    logger.warn(
      `${label} ${requirement.name}${version}: ${requirement.detail ?? requirement.state}`,
    );
  }
}

export function renderWorkspacePlan(plan: RealizationPlan, dryRun = false): void {
  logger.heading(`Workspace: ${colors.cyan(plan.workspace.name)}`);
  logger.info(
    colors.dim(
      `Profile: ${plan.workspace.profile ?? "default"} · Provider: ${plan.provider} · Root: ${plan.root}`,
    ),
  );
  if (plan.readOnly) {
    logger.warn("This workspace requests read-only access, but local setup cannot enforce it.");
  }

  logger.info();
  logger.heading(dryRun ? "Repository plan" : "Repositories");
  for (const repository of plan.repositories) {
    const line = `${repositoryLabel(repository)} — ${repositoryVerb(repository)}`;
    if (repository.action === "none") logger.success(line);
    else if (repository.action === "conflict") logger.warn(line);
    else logger.info(`${colors.dim("•")} ${line}`);
  }

  if (plan.tools.length > 0 || plan.services.length > 0 || plan.environment.length > 0) {
    logger.info();
    logger.heading("Environment");
    for (const requirement of plan.tools) renderRequirement("tool", requirement);
    for (const requirement of plan.services) renderRequirement("service", requirement);
    for (const requirement of plan.environment) {
      if (requirement.available) {
        logger.success(
          `environment variable ${requirement.name}${colors.dim(
            ` — available from ${environmentSource(requirement.availableFrom)}`,
          )}`,
        );
      } else {
        logger.warn(`environment variable ${requirement.name}: missing`);
      }
    }
  }

  if (Object.keys(plan.commands).length > 0) {
    logger.info();
    logger.heading("Commands");
    for (const command of Object.values(plan.commands)) {
      const location = command.repository ? ` [${command.repository}]` : "";
      logger.info(`  ${colors.cyan(command.id)}${colors.dim(location)}: ${command.run}`);
    }
  }

  if (plan.constraints.length > 0) {
    logger.info();
    logger.heading("Constraints");
    for (const constraint of plan.constraints) logger.info(`  - ${constraint}`);
  }

  if (dryRun) {
    logger.info();
    logger.next("Re-run without --dry-run to prepare this workspace.");
  }
}

export function renderRealizationResult(result: RealizationResult): void {
  if (result.applied.length > 0) {
    logger.info();
    logger.heading("Completed");
    for (const item of result.applied) logger.success(`${item.kind} ${item.name}`);
  }
  for (const failure of result.failures) {
    logger.error(`${failure.kind} ${failure.name}: ${failure.message}`);
  }
}
