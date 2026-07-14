import path from "node:path";
import { readWorkspaceContext } from "../core/context";
import { loadWorkspaceDefinition } from "../core/discovery";
import { getWorkspaceProvider } from "../core/localProvider";
import { WORKSPACE_SCHEMA_VERSION, resolveWorkspace } from "../core/workspace";
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

  const output = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspace: {
      id: inspection.workspace.id,
      name: inspection.workspace.name,
      profile: inspection.workspace.profile,
      provider: inspection.provider,
      root: inspection.root,
      ready: inspection.ready,
      readOnly: inspection.readOnly,
    },
    repositories: inspection.repositories.map((repository) => ({
      id: repository.id,
      role: repository.role ?? null,
      path: path.join(inspection.root, ...repository.path.split("/")),
      relativePath: repository.path,
      state: repository.state,
      action: repository.action,
      ref: repository.ref ?? null,
      currentRef: repository.currentRef ?? null,
      dirty: repository.dirty ?? null,
      detail: repository.detail ?? null,
    })),
    tools: inspection.tools,
    services: inspection.services,
    commands: inspection.commands,
    environment: inspection.environment,
    constraints: inspection.constraints,
    blockers: inspection.blockers,
  };
  logger.info(JSON.stringify(output, null, 2));
}
