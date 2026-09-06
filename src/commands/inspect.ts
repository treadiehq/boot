import { inspectRuntime } from "../core/sessionRuntime";
import path from "node:path";
import { readWorkspaceContext } from "../core/context";
import { buildWorkspaceDiagnostics } from "../core/diagnostics";
import { loadWorkspaceDefinition } from "../core/discovery";
import { getWorkspaceProvider } from "../core/localProvider";
import { resolveWorkspace } from "../core/workspace";
import { logger } from "../ui/logger";
import { renderWorkspacePlan } from "../ui/workspace";
import { findSession, readJson } from "../core/sessionStore";

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

  const diagnostics = buildWorkspaceDiagnostics(inspection);
  const pointer = await readJson(path.join(root, ".boot", "session.json")) as { id: string; store: string } | null;
  if (pointer) {
    const session = await findSession(pointer.id, pointer.store);
    const runtime = await inspectRuntime(session);
    diagnostics.session = { id: session.id, name: session.name, sourceRoot: session.sourceRoot, state: session.state,
      access: "same-user-filesystem", repositories: session.repositories.map(({ id, base, backend, fallbackReason, relativePath, submoduleOf }) => ({ id, base, backend, fallbackReason, relativePath, ...(submoduleOf ? { submoduleOf } : {}) })),
      ...(runtime ? { runtime } : {}) };
    if (runtime) {
      // These values are provided by session run; inspection reports only
      // availability and resource state, never credentials or connection URLs.
      const names = new Set([...session.runtime!.ports, ...session.runtime!.databases].map((resource) => resource.env));
      for (const env of diagnostics.environment) if (names.has(env.name)) { env.available = true; env.availableFrom = "session"; }
      diagnostics.blockers = diagnostics.blockers.filter((blocker) => ![...names].some((name) => blocker === `${JSON.stringify(name)}: required environment variable is not available`));
      diagnostics.blockers.push(...runtime.protection);
      diagnostics.workspace.ready = diagnostics.blockers.length === 0;
    }
  }
  if (!options.json) {
    renderWorkspacePlan({ ...inspection, environment: diagnostics.environment, ready: diagnostics.workspace.ready, blockers: diagnostics.blockers });
    logger.info();
    logger.info(diagnostics.workspace.ready ? "This workspace is ready." : `${diagnostics.blockers.length} requirements need attention.`);
    if (diagnostics.session?.runtime) logger.info("Session runtime variables are supplied by boot session run.");
    return;
  }

  logger.info(JSON.stringify(diagnostics, null, 2));
}
