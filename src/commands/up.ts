import path from "node:path";
import { CONTEXT_VERSION, writeWorkspaceContext } from "../core/context";
import { loadWorkspaceDefinition } from "../core/discovery";
import { getWorkspaceProvider } from "../core/localProvider";
import { resolveWorkspace } from "../core/workspace";
import { logger } from "../ui/logger";
import { renderRealizationResult, renderWorkspacePlan } from "../ui/workspace";

export interface UpOptions {
  profile?: string;
  provider?: string;
  dryRun?: boolean;
  json?: boolean;
  env?: boolean;
  runSetup?: boolean;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function upCommand(
  workspacePath = ".",
  options: UpOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  const definition = await loadWorkspaceDefinition(root);
  const workspace = resolveWorkspace(definition, options.profile);
  const provider = getWorkspaceProvider(options.provider ?? "local");
  const plan = await provider.plan(root, workspace);

  if (options.dryRun) {
    if (options.json) logger.info(JSON.stringify(plan, null, 2));
    else renderWorkspacePlan(plan, true);
    return;
  }

  if (!options.json) renderWorkspacePlan(plan);
  const result = await provider.apply(root, workspace, plan, {
    materializeEnv: options.env !== false,
    runSetup: options.runSetup,
  });

  if (result.ready) {
    await writeWorkspaceContext(root, {
      version: CONTEXT_VERSION,
      workspaceId: workspace.id,
      profile: workspace.profile,
      provider: provider.name,
      readyAt: new Date().toISOString(),
    });
  }

  if (options.json) {
    logger.info(JSON.stringify(result, null, 2));
  } else {
    renderRealizationResult(result);
    logger.info();
    if (result.ready) {
      logger.success("The workspace is ready.");
      logger.next(`Inspect it as JSON: boot inspect ${commandArg(root)} --json`);
    }
  }

  if (!result.ready) {
    const blockers = result.plan.blockers.length + result.failures.length;
    throw new Error(
      `The workspace is not ready: ${blockers} ${blockers === 1 ? "problem" : "problems"}. ` +
        `Run: boot inspect ${commandArg(root)} --json`,
    );
  }
}
