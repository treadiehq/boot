/** Payload shapes returned by the `boot ui` server (`src/core/uiServer.ts`). */

export interface WorkspaceSummary {
  root: string;
  name: string | null;
  description?: string | null;
  lastUsedAt: string;
  exists: boolean;
  profiles: string[];
  defaultProfile: string | null;
  error?: string;
}

export type RequirementState = "available" | "missing" | "mismatch" | "unsupported";

export interface RequirementStatus {
  name: string;
  required?: string;
  state: RequirementState;
  observed?: string;
  detail?: string;
}

export interface EnvironmentStatus {
  name: string;
  secret: boolean;
  source?: string;
  available: boolean;
  availableFrom?: "process" | "boot";
}

export interface RepositoryDiagnostics {
  id: string;
  role: string | null;
  relativePath: string;
  state: "hydrated" | "placeholder" | "missing" | "conflict";
  action: string;
  ref: string | null;
  currentRef: string | null;
  dirty: boolean | null;
  detail: string | null;
}

export interface WorkspaceDiagnostics {
  workspace: {
    id: string;
    name: string;
    profile: string | null;
    root: string;
    ready: boolean;
  };
  repositories: RepositoryDiagnostics[];
  tools: RequirementStatus[];
  services: RequirementStatus[];
  environment: EnvironmentStatus[];
  constraints: string[];
  blockers: string[];
}

/** NDJSON lines streamed by `POST /api/up`. */
export type UpStreamLine =
  | { type: "plan"; ready: boolean; blockers: string[] }
  | { type: "service"; service: string; phase: "starting" | "waiting" | "ready" | "failed" | "skipped"; detail?: string }
  | {
      type: "result";
      ready: boolean;
      applied: Array<{ kind: string; name: string }>;
      failures: Array<{ kind: string; name: string; message: string }>;
      diagnostics: WorkspaceDiagnostics;
    }
  | { type: "error"; message: string };

export interface ConsoleLine {
  glyph: string;
  text: string;
  tone: "ok" | "info" | "dim" | "warn" | "error" | "accent";
}
