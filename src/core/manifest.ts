import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MANIFEST_VERSION = "0.2" as const;

export const packageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]).nullable();
export const projectTypeSchema = z.enum(["node", "python", "go", "rust", "unknown"]);

export const hydrateStatusSchema = z.enum(["local", "placeholder", "hydrated"]);
export const hydrateStrategySchema = z.enum(["eager", "manual"]);

export const hydrateSchema = z.object({
  status: hydrateStatusSchema,
  strategy: hydrateStrategySchema,
});

export const repoSchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  absolutePath: z.string(),
  remoteUrl: z.string().nullable(),
  currentBranch: z.string().nullable(),
  dirty: z.boolean(),
  lastCommit: z.string().nullable(),
  packageManager: packageManagerSchema,
  projectType: projectTypeSchema,
  detectedFiles: z.array(z.string()),
  ignoredHints: z.array(z.string()),
  hydrate: hydrateSchema,
});

export const ignoreFileEntrySchema = z.object({
  path: z.string(),
  scope: z.enum(["workspace", "repo"]),
  rules: z.array(z.string()),
});

export const manifestConfigSchema = z.object({
  ignoreFiles: z.array(ignoreFileEntrySchema),
  defaultIgnoreRules: z.array(z.string()),
});

export const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.string(),
  workspace: z.object({
    rootName: z.string(),
    sourcePath: z.string(),
  }),
  config: manifestConfigSchema,
  repos: z.array(repoSchema),
});

export type RepoEntry = z.infer<typeof repoSchema>;
export type ManifestConfig = z.infer<typeof manifestConfigSchema>;
export type HydrateInfo = z.infer<typeof hydrateSchema>;
export type BootManifest = z.infer<typeof manifestSchema>;

export interface BuildManifestInput {
  rootName: string;
  sourcePath: string;
  config: ManifestConfig;
  repos: RepoEntry[];
}

export function buildManifest(input: BuildManifestInput): BootManifest {
  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    workspace: {
      rootName: input.rootName,
      sourcePath: input.sourcePath,
    },
    config: input.config,
    repos: input.repos,
  };
}

export async function writeManifest(filePath: string, manifest: BootManifest): Promise<string> {
  const abs = path.resolve(filePath);
  await fs.writeFile(abs, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return abs;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/** Read, JSON-parse, and validate a snapshot file against the current schema. */
export async function readManifest(filePath: string): Promise<BootManifest> {
  const abs = path.resolve(filePath);

  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`Manifest not found: ${abs}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Manifest is not valid JSON: ${abs}`);
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Manifest failed validation: ${abs}\n${formatIssues(result.error)}`);
  }
  return result.data;
}
