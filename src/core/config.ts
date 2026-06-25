import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Name of the optional workspace config file. */
export const CONFIG_FILE_NAME = "boot.yaml";

export const hydrateStrategySchema = z.enum(["eager", "manual"]);
export type HydrateStrategy = z.infer<typeof hydrateStrategySchema>;

/** Schema for the raw, on-disk `boot.yaml`. Every section is optional. */
export const configFileSchema = z
  .object({
    workspace: z.object({ name: z.string() }).partial().optional(),
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
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

/** Fully-resolved config with all defaults applied. */
export interface ResolvedConfig {
  workspaceName: string | null;
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
    throw new Error(`Could not parse ${CONFIG_FILE_NAME}: ${(err as Error).message}`);
  }

  // An empty YAML document parses to null/undefined — treat as an empty config.
  if (data === null || data === undefined) return {};

  const result = configFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${CONFIG_FILE_NAME} failed validation:\n${issues}`);
  }
  return result.data;
}

/** Apply a parsed config file on top of the defaults. */
export function resolveConfig(file: ConfigFile, sourcePath: string | null): ResolvedConfig {
  return {
    workspaceName: file.workspace?.name ?? DEFAULT_CONFIG.workspaceName,
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
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  const file = parseConfig(raw);
  return resolveConfig(file, CONFIG_FILE_NAME);
}
