import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./files";
import { portableRelativePathSchema } from "./pathUtils";
import {
  fileReadError,
  isFileNotFoundError,
  quoteUserValue,
  shellQuoteUserValue,
} from "./userErrors";

/** Directory and file that mark a folder as a boot placeholder. */
export const PLACEHOLDER_DIR = ".boot";
export const PLACEHOLDER_FILE = "repo.json";
export const PLACEHOLDER_README = "README.md";

export const placeholderSchema = z.object({
  name: z.string(),
  relativePath: portableRelativePathSchema,
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
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw fileReadError("repository placeholder data", jsonPath, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Repository download information at ${quoteUserValue(jsonPath, 500)} is not valid JSON. Run \`boot pull\` from the workspace root to recreate it.`,
    );
  }

  const result = placeholderSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Repository download information at ${quoteUserValue(jsonPath, 500)} has an invalid format (${issues}). Run \`boot pull\` from the workspace root to recreate it.`,
    );
  }
  return result.data;
}

export async function writePlaceholder(repoDir: string, meta: PlaceholderMeta): Promise<void> {
  const { jsonPath } = placeholderPaths(repoDir);
  await writeFileAtomic(jsonPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function renderReadme(meta: PlaceholderMeta): string {
  const hydratable = Boolean(meta.remoteUrl);
  const lines = [
    "# Repository not downloaded",
    "",
    `Repository ${quoteUserValue(meta.name)} has not been downloaded.`,
    "This folder only contains the information Boot needs to download it.",
    "",
  ];
  if (hydratable) {
    lines.push(
      "From the workspace root, run:",
      "",
      "```bash",
      `boot hydrate ${shellQuoteUserValue(meta.relativePath)}`,
      "```",
    );
  } else {
    lines.push(
      "No repository URL is recorded, so Boot cannot download it.",
      "Add its URL to `boot.yaml`, then run `boot up .` from the workspace root.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function writePlaceholderReadme(repoDir: string, meta: PlaceholderMeta): Promise<void> {
  const { readmePath } = placeholderPaths(repoDir);
  await writeFileAtomic(readmePath, renderReadme(meta));
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
