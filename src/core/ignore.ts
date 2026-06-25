import fs from "node:fs/promises";
import path from "node:path";
import { toPosixRelative } from "./pathUtils";

/** Name of the user-controlled ignore file, at workspace or repo scope. */
export const IGNORE_FILE_NAME = ".bootignore";

/**
 * Internal default ignore rules, expressed in gitignore-style syntax. These are
 * always applied and are recorded in the manifest as `defaultIgnoreRules`.
 */
export const DEFAULT_IGNORE_RULES: string[] = [
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "target/",
  ".venv/",
  "vendor/",
  ".turbo/",
  ".cache/",
  ".git/",
  // boot's own metadata: the workspace-level `.boot/` holds the synced map repo,
  // and repo-level `.boot/` holds placeholder metadata. Never scan into it.
  ".boot/",
];

export type IgnoreScope = "workspace" | "repo";

export interface IgnoreFileEntry {
  /** Posix path, relative to the workspace root, of the ignore file. */
  path: string;
  scope: IgnoreScope;
  rules: string[];
}

/**
 * Parse `.bootignore` content into a clean rule list. Blank lines and
 * `#` comments are dropped. Negation (`!`) is intentionally not supported yet —
 * we keep the matcher simple.
 */
export function parseIgnoreContent(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Read and parse an ignore file. Returns null when the file does not exist. */
export async function readIgnoreFile(filePath: string): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  return parseIgnoreContent(raw);
}

/**
 * Read a workspace- or repo-scoped ignore file and turn it into a manifest
 * entry. Returns null when no ignore file is present in `dir`.
 */
export async function loadIgnoreFileEntry(
  workspaceRoot: string,
  dir: string,
  scope: IgnoreScope,
): Promise<IgnoreFileEntry | null> {
  const filePath = path.join(dir, IGNORE_FILE_NAME);
  const rules = await readIgnoreFile(filePath);
  if (!rules) return null;
  const rel = toPosixRelative(workspaceRoot, filePath) || IGNORE_FILE_NAME;
  return { path: rel, scope, rules };
}

function globToRegExp(glob: string): RegExp {
  // Escape regex specials, then re-enable `*` (matches within a path segment)
  // and `?` (single char). This is a deliberately small glob implementation.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`);
}

interface CompiledRule {
  /** True when the rule only applies to directories (trailing slash). */
  dirOnly: boolean;
  test: (name: string) => boolean;
}

function compileRule(rule: string): CompiledRule {
  const dirOnly = rule.endsWith("/");
  const body = dirOnly ? rule.slice(0, -1) : rule;
  if (body.includes("*") || body.includes("?")) {
    const re = globToRegExp(body);
    return { dirOnly, test: (name) => re.test(name) };
  }
  return { dirOnly, test: (name) => name === body };
}

export interface IgnoreMatcher {
  readonly rules: string[];
  /** Whether a single path segment (file or directory name) is ignored. */
  isIgnored(name: string, isDirectory: boolean): boolean;
}

/**
 * Build a matcher from a merged rule list. Matching is by single path segment
 * (basename), which is all the scanner needs to decide whether to descend into
 * a directory or to flag a generated folder.
 */
export function createIgnoreMatcher(rules: string[]): IgnoreMatcher {
  const unique = [...new Set(rules)];
  const compiled = unique.map(compileRule);
  return {
    rules: unique,
    isIgnored(name: string, isDirectory: boolean): boolean {
      for (const rule of compiled) {
        if (rule.dirOnly && !isDirectory) continue;
        if (rule.test(name)) return true;
      }
      return false;
    },
  };
}

/** Merge default rules, config rules, and ignore-file rules into one matcher. */
export function mergeIgnoreRules(...ruleSets: string[][]): string[] {
  return ruleSets.flat();
}
