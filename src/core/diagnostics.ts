import path from "node:path";
import { z } from "zod";
import type { RealizationPlan } from "./provider";

export const WORKSPACE_DIAGNOSTICS_VERSION = 1 as const;

const requirementStatusSchema = z
  .object({
    name: z.string(),
    required: z.string().optional(),
    state: z.enum(["available", "missing", "mismatch", "unsupported"]),
    observed: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

const environmentStatusSchema = z
  .object({
    name: z.string(),
    secret: z.boolean(),
    source: z.string().optional(),
    available: z.boolean(),
    availableFrom: z.enum(["process", "boot"]).optional(),
  })
  .strict();

const resolvedCommandSchema = z
  .object({
    id: z.string(),
    run: z.string(),
    repository: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

export const workspaceDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_DIAGNOSTICS_VERSION),
    workspace: z
      .object({
        id: z.string(),
        name: z.string(),
        profile: z.string().nullable(),
        provider: z.string(),
        root: z.string(),
        ready: z.boolean(),
        readOnly: z.boolean(),
      })
      .strict(),
    repositories: z.array(
      z
        .object({
          id: z.string(),
          role: z.string().nullable(),
          path: z.string(),
          relativePath: z.string(),
          state: z.enum(["hydrated", "placeholder", "missing", "conflict"]),
          action: z.enum([
            "none",
            "clone",
            "placeholder",
            "hydrate",
            "update-placeholder",
            "checkout",
            "conflict",
          ]),
          ref: z.string().nullable(),
          currentRef: z.string().nullable(),
          dirty: z.boolean().nullable(),
          detail: z.string().nullable(),
        })
        .strict(),
    ),
    tools: z.array(requirementStatusSchema),
    services: z.array(requirementStatusSchema),
    commands: z.record(z.string(), resolvedCommandSchema),
    environment: z.array(environmentStatusSchema),
    constraints: z.array(z.string()),
    blockers: z.array(z.string()),
  })
  .strict();

export type WorkspaceDiagnostics = z.infer<typeof workspaceDiagnosticsSchema>;

/** Build the stable, secret-free machine contract shared by inspect/bootstrap. */
export function buildWorkspaceDiagnostics(
  plan: RealizationPlan,
  rootOverride?: string,
): WorkspaceDiagnostics {
  const root = path.resolve(rootOverride ?? plan.root);
  return workspaceDiagnosticsSchema.parse({
    schemaVersion: WORKSPACE_DIAGNOSTICS_VERSION,
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
  });
}
