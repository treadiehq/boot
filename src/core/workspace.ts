import { z } from "zod";
import { portableRelativePathSchema } from "./pathUtils";
import { quoteUserValue } from "./userErrors";

export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export const identifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must contain only letters, numbers, '.', '_' or '-'");

export const workspaceIdSchema = z.string().min(1).superRefine((value, ctx) => {
  const parts = value.split("/");
  if (parts.some((part) => !identifierSchema.safeParse(part).success)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be an identifier or slash-separated identifiers",
    });
  }
});

export const materializationSchema = z.enum(["eager", "manual"]);
export type Materialization = z.infer<typeof materializationSchema>;

export const repositoryDefinitionSchema = z
  .object({
    url: z.string().min(1).optional(),
    path: portableRelativePathSchema,
    role: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    hydrate: materializationSchema.optional(),
  })
  .strict();

export type RepositoryDefinition = z.infer<typeof repositoryDefinitionSchema>;

export const serviceDefinitionSchema = z
  .object({
    type: identifierSchema.optional(),
    version: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();

export type ServiceDefinition = z.infer<typeof serviceDefinitionSchema>;

export const commandDefinitionSchema = z.union([
  z.string().min(1),
  z
    .object({
      run: z.string().min(1),
      repository: identifierSchema.optional(),
      description: z.string().min(1).optional(),
    })
    .strict(),
]);

export type CommandDefinition = z.infer<typeof commandDefinitionSchema>;

const environmentVariableNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

export const environmentRequirementSchema = z.union([
  environmentVariableNameSchema,
  z
    .object({
      name: environmentVariableNameSchema,
      description: z.string().min(1).optional(),
      secret: z.boolean().default(true),
      source: z.string().min(1).optional(),
    })
    .strict(),
]);

export type EnvironmentRequirement = z.infer<typeof environmentRequirementSchema>;

const selectionSchema = z.union([z.literal("all"), z.array(identifierSchema)]);
const environmentSelectionSchema = z.union([
  z.literal("all"),
  z.array(environmentVariableNameSchema),
]);

export const profileDefinitionSchema = z
  .object({
    repositories: selectionSchema.optional(),
    tools: selectionSchema.optional(),
    services: selectionSchema.optional(),
    commands: selectionSchema.optional(),
    env: environmentSelectionSchema.optional(),
    hydrate: materializationSchema.optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();

export type ProfileDefinition = z.infer<typeof profileDefinitionSchema>;

const repositoryRecordSchema = z
  .record(identifierSchema, repositoryDefinitionSchema)
  .superRefine((repositories, ctx) => {
    const seen = new Map<string, string>();
    const paths = Object.entries(repositories)
      .map(([id, repository]) => ({ id, path: repository.path.toLowerCase() }))
      .sort((a, b) => a.path.localeCompare(b.path));

    for (const repository of paths) {
      const existing = seen.get(repository.path);
      if (existing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [repository.id, "path"],
          message: `duplicates repository path used by "${existing}"`,
        });
      }
      seen.set(repository.path, repository.id);
    }

    for (let index = 0; index < paths.length; index += 1) {
      const parent = paths[index]!;
      for (let candidateIndex = index + 1; candidateIndex < paths.length; candidateIndex += 1) {
        const candidate = paths[candidateIndex]!;
        if (candidate.path.startsWith(`${parent.path}/`)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [candidate.id, "path"],
            message: `cannot be nested inside repository "${parent.id}"`,
          });
        }
      }
    }
  });

export const workspaceDefinitionSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
    workspace: z
      .object({
        id: workspaceIdSchema,
        name: z.string().min(1),
        description: z.string().min(1).optional(),
      })
      .strict(),
    repositories: repositoryRecordSchema,
    tools: z.record(identifierSchema, z.string().min(1)).optional(),
    services: z.record(identifierSchema, serviceDefinitionSchema).optional(),
    commands: z.record(identifierSchema, commandDefinitionSchema).optional(),
    env: z
      .object({
        required: z.array(environmentRequirementSchema).default([]),
      })
      .strict()
      .optional(),
    constraints: z.array(z.string().min(1)).optional(),
    profiles: z.record(identifierSchema, profileDefinitionSchema).optional(),
    defaults: z
      .object({
        profile: identifierSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const repositoryIds = new Set(Object.keys(definition.repositories));
    const toolIds = new Set(Object.keys(definition.tools ?? {}));
    const serviceIds = new Set(Object.keys(definition.services ?? {}));
    const commandIds = new Set(Object.keys(definition.commands ?? {}));
    const envIds = new Set(
      (definition.env?.required ?? []).map((requirement) =>
        typeof requirement === "string" ? requirement : requirement.name,
      ),
    );

    const validateSelection = (
      profileId: string,
      field: "repositories" | "tools" | "services" | "commands" | "env",
      values: "all" | string[] | undefined,
      available: Set<string>,
    ): void => {
      if (!values || values === "all") return;
      for (const value of values) {
        if (!available.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profileId, field],
            message: `references unknown ${field} entry "${value}"`,
          });
        }
      }
    };

    for (const [profileId, profile] of Object.entries(definition.profiles ?? {})) {
      validateSelection(profileId, "repositories", profile.repositories, repositoryIds);
      validateSelection(profileId, "tools", profile.tools, toolIds);
      validateSelection(profileId, "services", profile.services, serviceIds);
      validateSelection(profileId, "commands", profile.commands, commandIds);
      validateSelection(profileId, "env", profile.env, envIds);
    }

    for (const [commandId, command] of Object.entries(definition.commands ?? {})) {
      if (
        typeof command !== "string" &&
        command.repository &&
        !repositoryIds.has(command.repository)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["commands", commandId, "repository"],
          message: `references unknown repository "${command.repository}"`,
        });
      }
    }

    const defaultProfile = definition.defaults?.profile;
    if (defaultProfile && !definition.profiles?.[defaultProfile]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaults", "profile"],
        message: `references unknown profile "${defaultProfile}"`,
      });
    }
  });

export type WorkspaceDefinition = z.infer<typeof workspaceDefinitionSchema>;

export interface ResolvedRepository extends RepositoryDefinition {
  id: string;
  hydrate: Materialization;
}

export interface ResolvedCommand {
  id: string;
  run: string;
  repository?: string;
  description?: string;
}

export interface ResolvedEnvironmentRequirement {
  name: string;
  description?: string;
  secret: boolean;
  source?: string;
}

export interface ResolvedWorkspace {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  profile: string | null;
  readOnly: boolean;
  repositories: ResolvedRepository[];
  tools: Record<string, string>;
  services: Record<string, ServiceDefinition>;
  commands: Record<string, ResolvedCommand>;
  env: ResolvedEnvironmentRequirement[];
  constraints: string[];
}

function selectedIds(
  selection: "all" | string[] | undefined,
  available: Record<string, unknown>,
): string[] {
  if (!selection || selection === "all") return Object.keys(available);
  return selection;
}

/** Resolve a Profile into the concrete Workspace an actor should receive. */
export function resolveWorkspace(
  definition: WorkspaceDefinition,
  requestedProfile?: string,
): ResolvedWorkspace {
  const profileId =
    requestedProfile ??
    definition.defaults?.profile ??
    (definition.profiles?.local ? "local" : null);
  const profile = profileId ? definition.profiles?.[profileId] : undefined;
  if (profileId && !profile) {
    throw new Error(
      `Profile ${quoteUserValue(profileId)} was not found. Available profiles: ${
        Object.keys(definition.profiles ?? {}).map((name) => quoteUserValue(name)).join(", ") ||
        "none"
      }.`,
    );
  }

  const repositoryIds = selectedIds(profile?.repositories, definition.repositories);
  const repositories = repositoryIds.map((id) => {
    const repository = definition.repositories[id]!;
    return {
      id,
      ...repository,
      hydrate: profile?.hydrate ?? repository.hydrate ?? "manual",
    };
  });
  const selectedRepositoryIds = new Set(repositoryIds);

  const tools = Object.fromEntries(
    selectedIds(profile?.tools, definition.tools ?? {}).map((id) => [
      id,
      definition.tools?.[id]!,
    ]),
  );
  const services = Object.fromEntries(
    selectedIds(profile?.services, definition.services ?? {}).map((id) => [
      id,
      definition.services?.[id]!,
    ]),
  );

  const commands: Record<string, ResolvedCommand> = {};
  for (const id of selectedIds(profile?.commands, definition.commands ?? {})) {
    const command = definition.commands?.[id]!;
    const resolved =
      typeof command === "string"
        ? { id, run: command }
        : { id, run: command.run, repository: command.repository, description: command.description };
    if (!resolved.repository || selectedRepositoryIds.has(resolved.repository)) {
      commands[id] = resolved;
    }
  }

  const requirementsByName = new Map(
    (definition.env?.required ?? []).map((requirement) => {
      const resolved =
        typeof requirement === "string"
          ? { name: requirement, secret: true }
          : {
              name: requirement.name,
              description: requirement.description,
              secret: requirement.secret,
              source: requirement.source,
            };
      return [resolved.name, resolved] as const;
    }),
  );
  const env = selectedIds(
    profile?.env,
    Object.fromEntries([...requirementsByName].map(([name]) => [name, true])),
  ).map((name) => requirementsByName.get(name)!);

  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: definition.workspace.id,
    name: definition.workspace.name,
    description: definition.workspace.description,
    profile: profileId,
    readOnly: profile?.readOnly ?? false,
    repositories,
    tools,
    services,
    commands,
    env,
    constraints: definition.constraints ?? [],
  };
}
