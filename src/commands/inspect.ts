import path from "node:path";
import { readWorkspaceContext } from "../core/context";
import { buildWorkspaceDiagnostics } from "../core/diagnostics";
import { loadWorkspaceDefinition } from "../core/discovery";
import { getWorkspaceProvider } from "../core/localProvider";
import { resolveWorkspace } from "../core/workspace";
import { logger } from "../ui/logger";
import { renderWorkspacePlan } from "../ui/workspace";

export interface InspectOptions {
  profile?: string;
  provider?: string;
  json?: boolean;
}

export async function inspectCommand(
  workspacePath = ".",
  options: InspectOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  const definition = await loadWorkspaceDefinition(root);
  const context = await readWorkspaceContext(root);
  const activeContext = context?.workspaceId === definition.workspace.id ? context : null;
  const profile = options.profile ?? activeContext?.profile ?? undefined;
  const provider = getWorkspaceProvider(
    options.provider ?? activeContext?.provider ?? "local",
  );
  const workspace = resolveWorkspace(definition, profile);
  const inspection = await provider.inspect(root, workspace);

  if (!options.json) {
    renderWorkspacePlan(inspection);
    logger.info();
    logger.info(
      inspection.ready
        ? "This workspace is ready."
        : `${inspection.blockers.length} ${
            inspection.blockers.length === 1 ? "requirement needs" : "requirements need"
          } attention.`,
    );
    return;
  }

  logger.info(JSON.stringify(buildWorkspaceDiagnostics(inspection), null, 2));
}
