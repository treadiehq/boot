import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  materializationSchema,
  workspaceDefinitionSchema,
  type WorkspaceDefinition,
} from "./workspace";
import {
  fileReadError,
  isFileNotFoundError,
  sanitizeUserText,
} from "./userErrors";

/** Name of the optional workspace config file. */
export const CONFIG_FILE_NAME = "boot.yaml";

export const hydrateStrategySchema = materializationSchema;
export type HydrateStrategy = z.infer<typeof hydrateStrategySchema>;

const operationalFields = {
  hydrate: z.object({ strategy: hydrateStrategySchema }).partial().optional(),
  ignore: z.array(z.string()).optional(),
  doctor: z
    .object({
      defaultBranchNames: z.array(z.string()).optional(),
      staleAfterDays: z.number().int().positive().optional(),
    })
    .partial()
    .optional(),
  daemon: z
    .object({
      intervalSeconds: z.number().int().positive().optional(),
      fetch: z.boolean().optional(),
      fastForward: z.boolean().optional(),
    })
    .partial()
    .optional(),
};

/** The pre-Workspace `boot.yaml` shape, retained as a read-only compatibility input. */
export const legacyConfigFileSchema = z
  .object({
    workspace: z.object({ name: z.string() }).partial().optional(),
    ...operationalFields,
  })
  .strict();

/** Current, versioned Workspace definition plus Boot's local operating policy. */
export const currentConfigFileSchema = workspaceDefinitionSchema.safeExtend(operationalFields);

/** Schema for the raw, on-disk `boot.yaml`. */
export const configFileSchema = z.union([currentConfigFileSchema, legacyConfigFileSchema]);

export type ConfigFile = z.infer<typeof configFileSchema>;

/** Fully-resolved config with all defaults applied. */
export interface ResolvedConfig {
  workspaceName: string | null;
  /** Canonical Workspace definition. Null for a legacy config. */
  definition: WorkspaceDefinition | null;
  hydrateStrategy: HydrateStrategy;
  ignore: string[];
  defaultBranchNames: string[];
  staleAfterDays: number;
  /** How often the daemon syncs, in seconds. */
  daemonIntervalSeconds: number;
  /** Whether the daemon fetches remotes to assess freshness. */
  daemonFetch: boolean;
  /** Whether the daemon fast-forwards clean default-branch repos. */
  daemonFastForward: boolean;
  /** Posix path of the loaded config file, relative to the workspace, or null. */
  sourcePath: string | null;
}

/** Sane defaults used when no `boot.yaml` is present. */
export const DEFAULT_CONFIG: ResolvedConfig = {
  workspaceName: null,
  definition: null,
  // "eager" preserves the original restore behavior (clone on restore) when the
  // workspace has no config. Use `restore --lazy` or `hydrate.strategy: manual`
  // to defer cloning.
  hydrateStrategy: "eager",
  ignore: [],
  defaultBranchNames: ["main", "master"],
  staleAfterDays: 30,
  daemonIntervalSeconds: 60,
  daemonFetch: true,
  daemonFastForward: true,
  sourcePath: null,
};

/** Parse and validate raw YAML text into a typed config object. */
export function parseConfig(raw: string): ConfigFile {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    const reason = sanitizeUserText((err as Error).message);
    throw new Error(
      `${CONFIG_FILE_NAME} is not valid YAML${reason ? `: ${reason}` : "."} Fix the file, then retry.`,
    );
  }

  // An empty YAML document parses to null/undefined — treat as an empty config.
  if (data === null || data === undefined) return {};

  const result = configFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `${CONFIG_FILE_NAME} has an invalid format (${issues}). Fix the file, then retry.`,
    );
  }
  return result.data;
}

/** Apply a parsed config file on top of the defaults. */
export function resolveConfig(file: ConfigFile, sourcePath: string | null): ResolvedConfig {
  const current = "schemaVersion" in file;
  let definition: WorkspaceDefinition | null = null;
  if (current) {
    const { hydrate: _hydrate, ignore: _ignore, doctor: _doctor, daemon: _daemon, ...product } =
      file;
    definition = workspaceDefinitionSchema.parse(product);
  }

  return {
    workspaceName: file.workspace?.name ?? DEFAULT_CONFIG.workspaceName,
    definition,
    hydrateStrategy: file.hydrate?.strategy ?? DEFAULT_CONFIG.hydrateStrategy,
    ignore: file.ignore ?? DEFAULT_CONFIG.ignore,
    defaultBranchNames: file.doctor?.defaultBranchNames ?? DEFAULT_CONFIG.defaultBranchNames,
    staleAfterDays: file.doctor?.staleAfterDays ?? DEFAULT_CONFIG.staleAfterDays,
    daemonIntervalSeconds: file.daemon?.intervalSeconds ?? DEFAULT_CONFIG.daemonIntervalSeconds,
    daemonFetch: file.daemon?.fetch ?? DEFAULT_CONFIG.daemonFetch,
    daemonFastForward: file.daemon?.fastForward ?? DEFAULT_CONFIG.daemonFastForward,
    sourcePath,
  };
}

/**
 * Load `boot.yaml` from `workspacePath` if present, returning a fully
 * resolved config. Falls back to defaults when the file does not exist.
 */
export async function loadConfig(workspacePath: string): Promise<ResolvedConfig> {
  const filePath = path.join(workspacePath, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return { ...DEFAULT_CONFIG };
    throw fileReadError(CONFIG_FILE_NAME, filePath, error);
  }
  const file = parseConfig(raw);
  return resolveConfig(file, CONFIG_FILE_NAME);
}
