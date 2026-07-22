import path from "node:path";
import type { RealizationPlan } from "./provider";
import { WORKSPACE_SCHEMA_VERSION } from "./workspace";

export interface WorkspaceDiagnostics {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  workspace: {
    id: string;
    name: string;
    profile: string | null;
    provider: string;
    root: string;
    ready: boolean;
    readOnly: boolean;
  };
  repositories: Array<{
    id: string;
    role: string | null;
    path: string;
    relativePath: string;
    state: RealizationPlan["repositories"][number]["state"];
    action: RealizationPlan["repositories"][number]["action"];
    ref: string | null;
    currentRef: string | null;
    dirty: boolean | null;
    detail: string | null;
  }>;
  tools: RealizationPlan["tools"];
  services: RealizationPlan["services"];
  commands: RealizationPlan["commands"];
  environment: RealizationPlan["environment"];
  constraints: string[];
  blockers: string[];
}

/** Build the stable, secret-free machine contract shared by inspect/bootstrap. */
export function buildWorkspaceDiagnostics(
  plan: RealizationPlan,
  rootOverride?: string,
): WorkspaceDiagnostics {
  const root = path.resolve(rootOverride ?? plan.root);
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspace: {
      id: plan.workspace.id,
      name: plan.workspace.name,
      profile: plan.workspace.profile,
      provider: plan.provider,
      root,
      ready: plan.ready,
      readOnly: plan.readOnly,
    },
    repositories: plan.repositories.map((repository) => ({
      id: repository.id,
      role: repository.role ?? null,
      path: path.join(root, ...repository.path.split("/")),
      relativePath: repository.path,
      state: repository.state,
      action: repository.action,
      ref: repository.ref ?? null,
      currentRef: repository.currentRef ?? null,
      dirty: repository.dirty ?? null,
      detail: repository.detail ?? null,
    })),
    tools: plan.tools,
    services: plan.services,
    commands: plan.commands,
    environment: plan.environment,
    constraints: plan.constraints,
    blockers: plan.blockers,
  };
}
