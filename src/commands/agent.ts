import path from "node:path";
import {
  bootstrapAgentWorkspace,
  bootstrapOutput,
  type BootstrapOptions,
} from "../core/bootstrap";
import { ensureGitAvailable } from "../core/git";
import { renderBootstrapResult } from "../ui/bootstrap";
import { logger } from "../ui/logger";

export interface AgentOptions extends BootstrapOptions {
  json?: boolean;
  /** Commander's `--start` flag; mapped to `startServices` for the core. */
  start?: boolean;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function retryCommand(
  remote: string,
  root: string,
  options: AgentOptions,
): string {
  const args = ["boot", "agent", commandArg(remote), commandArg(root)];

  if (options.profile) args.push("--profile", commandArg(options.profile));
  if (options.provider) args.push("--provider", commandArg(options.provider));
  if (options.runSetup) args.push("--run-setup");
  if (options.start || options.startServices) args.push("--start");
  if (options.env === true) args.push("--env");
  if (options.env === false) args.push("--no-env");
  if (options.folder) args.push("--folder");
  if (options.eager) args.push("--eager");
  if (options.all) args.push("--all");
  if (options.json) args.push("--json");
  if (options.hydrate?.length) {
    args.push("--hydrate", ...options.hydrate.map(commandArg));
  }

  return args.join(" ");
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function workspaceProblemSummary(
  blockers: number,
  failures: number,
): string {
  const parts: string[] = [];
  if (blockers > 0) {
    parts.push(countLabel(blockers, "current blocker", "current blockers"));
  }
  if (failures > 0) {
    parts.push(countLabel(failures, "failed action", "failed actions"));
  }
  return parts.join(" and ") || "readiness checks failed";
}

/**
 * One-shot, non-interactive bootstrap for CI, cloud agents, and fresh
 * containers. The core workflow is idempotent and returns all user-facing
 * state; this command only selects JSON or human rendering and exit behavior.
 */
export async function agentCommand(
  remote: string,
  workspacePath = ".",
  options: AgentOptions = {},
): Promise<void> {
  await ensureGitAvailable();
  const root = path.resolve(workspacePath);
  const result = await bootstrapAgentWorkspace(remote, root, {
    ...options,
    startServices: options.startServices ?? options.start,
  });

  if (options.json) {
    logger.info(JSON.stringify(bootstrapOutput(result), null, 2));
  } else {
    renderBootstrapResult(result);
  }

  if (!result.dryRun && !result.ready) {
    const summary =
      result.mode === "workspace"
        ? workspaceProblemSummary(
            result.plan.blockers.length,
            result.failures.length,
          )
        : countLabel(result.failures.length, "problem", "problems");
    throw new Error(
      `The agent workspace is not ready: ${summary}. ` +
        `Fix the reported problems, then run: ${retryCommand(remote, root, options)}`,
    );
  }
}
