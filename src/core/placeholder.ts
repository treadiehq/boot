import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Directory and file that mark a folder as a boot placeholder. */
export const PLACEHOLDER_DIR = ".boot";
export const PLACEHOLDER_FILE = "repo.json";
export const PLACEHOLDER_README = "README.md";

export const placeholderSchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  remoteUrl: z.string().nullable(),
  branch: z.string().nullable(),
  lastCommit: z.string().nullable(),
  hydrateStatus: z.enum(["placeholder", "hydrated"]),
  createdAt: z.string(),
});

export type PlaceholderMeta = z.infer<typeof placeholderSchema>;

export interface PlaceholderPaths {
  dir: string;
  jsonPath: string;
  readmePath: string;
}

export function placeholderPaths(repoDir: string): PlaceholderPaths {
  const dir = path.join(repoDir, PLACEHOLDER_DIR);
  return {
    dir,
    jsonPath: path.join(dir, PLACEHOLDER_FILE),
    readmePath: path.join(dir, PLACEHOLDER_README),
  };
}

/** Whether a folder contains placeholder metadata (`.boot/repo.json`). */
export function isPlaceholder(repoDir: string): boolean {
  return existsSync(placeholderPaths(repoDir).jsonPath);
}

/**
 * Read placeholder metadata. Returns null when the folder is not a placeholder.
 * Throws a friendly error when the metadata exists but is invalid.
 */
export async function readPlaceholder(repoDir: string): Promise<PlaceholderMeta | null> {
  const { jsonPath } = placeholderPaths(repoDir);
  let raw: string;
  try {
    raw = await fs.readFile(jsonPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Placeholder metadata is not valid JSON: ${jsonPath}`);
  }

  const result = placeholderSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Placeholder metadata failed validation: ${jsonPath}\n${issues}`);
  }
  return result.data;
}

export async function writePlaceholder(repoDir: string, meta: PlaceholderMeta): Promise<void> {
  const { dir, jsonPath } = placeholderPaths(repoDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function renderReadme(meta: PlaceholderMeta): string {
  const hydratable = Boolean(meta.remoteUrl);
  const lines = [
    "# boot placeholder",
    "",
    `This folder is a **boot** placeholder for \`${meta.name}\`. The repository`,
    "has not been cloned yet — only its metadata lives here.",
    "",
  ];
  if (hydratable) {
    lines.push(
      "Hydrate it (clone the real repo into this folder) with:",
      "",
      "```bash",
      `boot hydrate ${meta.relativePath}`,
      "```",
    );
  } else {
    lines.push(
      "> This placeholder has **no remote URL**, so it cannot be hydrated automatically.",
      "> The folder structure was recreated, but you'll need to restore its contents manually.",
    );
  }
  lines.push("", "Learn more: boot keeps a portable map of your workspace, not your files.", "");
  return lines.join("\n");
}

export async function writePlaceholderReadme(repoDir: string, meta: PlaceholderMeta): Promise<void> {
  const { dir, readmePath } = placeholderPaths(repoDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(readmePath, renderReadme(meta), "utf8");
}

/**
 * Hide the `.boot/` metadata folder from a hydrated repo's git status by
 * adding it to `.git/info/exclude`. This keeps the cloned repo clean without
 * touching any tracked files (we never modify the project's own `.gitignore`).
 * No-ops when the repo has no `.git/info` directory.
 */
export async function excludePlaceholderFromGit(repoDir: string): Promise<void> {
  const excludePath = path.join(repoDir, ".git", "info", "exclude");
  const entry = `${PLACEHOLDER_DIR}/`;

  let current = "";
  try {
    current = await fs.readFile(excludePath, "utf8");
  } catch {
    // The info dir may not exist (e.g. worktrees); create it best-effort.
    try {
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
    } catch {
      return;
    }
  }

  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry)) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludePath, `${prefix}${entry}\n`, "utf8");
}

export interface PlaceholderSource {
  name: string;
  relativePath: string;
  remoteUrl: string | null;
  currentBranch: string | null;
  lastCommit: string | null;
}

/** Build placeholder metadata from a repo entry (or similar source). */
export function buildPlaceholderMeta(
  source: PlaceholderSource,
  hydrateStatus: PlaceholderMeta["hydrateStatus"] = "placeholder",
  now: Date = new Date(),
): PlaceholderMeta {
  return {
    name: source.name,
    relativePath: source.relativePath,
    remoteUrl: source.remoteUrl,
    branch: source.currentBranch,
    lastCommit: source.lastCommit,
    hydrateStatus,
    createdAt: now.toISOString(),
  };
}
