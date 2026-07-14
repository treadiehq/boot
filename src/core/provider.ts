import type {
  EnvironmentStatus,
  RequirementStatus,
} from "./requirements";
import type { ResolvedWorkspace } from "./workspace";

export type RepositoryState = "hydrated" | "placeholder" | "missing" | "conflict";
export type RepositoryAction =
  | "none"
  | "clone"
  | "placeholder"
  | "hydrate"
  | "update-placeholder"
  | "checkout"
  | "conflict";

export interface RepositoryPlan {
  id: string;
  path: string;
  role?: string;
  url?: string;
  ref?: string;
  state: RepositoryState;
  action: RepositoryAction;
  currentRef?: string;
  dirty?: boolean;
  detail?: string;
}

export interface RealizationPlan {
  workspace: {
    id: string;
    name: string;
    profile: string | null;
  };
  provider: string;
  root: string;
  readOnly: boolean;
  repositories: RepositoryPlan[];
  tools: RequirementStatus[];
  services: RequirementStatus[];
  environment: EnvironmentStatus[];
  commands: ResolvedWorkspace["commands"];
  constraints: string[];
  ready: boolean;
  blockers: string[];
}

export interface RealizationOptions {
  materializeEnv?: boolean;
  runSetup?: boolean;
}

export interface RealizationResult {
  plan: RealizationPlan;
  applied: Array<{ kind: "repository" | "environment" | "command"; name: string }>;
  failures: Array<{ kind: "repository" | "environment" | "command"; name: string; message: string }>;
  ready: boolean;
}

/**
 * A Provider realizes one resolved Workspace in a target environment.
 * MapTransport remains a separate abstraction for synchronizing Boot metadata.
 */
export interface WorkspaceProvider {
  readonly name: string;
  inspect(root: string, workspace: ResolvedWorkspace): Promise<RealizationPlan>;
  plan(root: string, workspace: ResolvedWorkspace): Promise<RealizationPlan>;
  apply(
    root: string,
    workspace: ResolvedWorkspace,
    plan: RealizationPlan,
    options?: RealizationOptions,
  ): Promise<RealizationResult>;
}
