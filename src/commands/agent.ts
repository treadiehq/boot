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
  const result = await bootstrapAgentWorkspace(remote, root, options);

  if (options.json) {
    logger.info(JSON.stringify(bootstrapOutput(result), null, 2));
  } else {
    renderBootstrapResult(result);
  }

  if (!result.dryRun && !result.ready) {
    const problems =
      result.mode === "workspace"
        ? new Set([
            ...result.plan.blockers,
            ...result.failures.map((failure) => failure.message),
          ]).size
        : result.failures.length;
    throw new Error(
      `The agent workspace is not ready: ${problems} ${
        problems === 1 ? "problem" : "problems"
      }. Fix the reported problems, then run: ${retryCommand(remote, root, options)}`,
    );
  }
}
