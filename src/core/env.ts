import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { decrypt, encrypt, encryptedBlobSchema } from "./secrets";
import { writeFileAtomic } from "./files";
import { portableRelativePathSchema, resolveWithinRoot } from "./pathUtils";
import { fileReadError, isFileNotFoundError, quoteUserValue } from "./userErrors";

/** Where encrypted env files live inside the synced map repo. */
export const ENV_DIR = "env";
export const GLOBAL_SCOPE_FILE = "global.json";
export const REPO_SCOPE_DIR = "repos";
/** The materialised, plaintext dotenv filename written into the workspace. */
export const DOTENV_FILE = ".env";

export type EnvScope = { type: "global" } | { type: "repo"; relativePath: string };

export function envDir(mapDir: string): string {
  return path.join(mapDir, ENV_DIR);
}

/** Storage path for a scope's encrypted file inside the map repo. */
export function scopeFilePath(mapDir: string, scope: EnvScope): string {
  if (scope.type === "global") return path.join(envDir(mapDir), GLOBAL_SCOPE_FILE);
  const relativePath = portableRelativePathSchema.parse(scope.relativePath);
  return resolveWithinRoot(path.join(envDir(mapDir), REPO_SCOPE_DIR), `${relativePath}.json`);
}

export function scopeLabel(scope: EnvScope): string {
  return scope.type === "global" ? "global" : scope.relativePath;
}

/* ------------------------------------------------------------------ *
 * dotenv parse / serialize                                            *
 * ------------------------------------------------------------------ */

/** Parse a minimal `.env` body into a key/value map. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\(n|"|\\)/g, (_match, escaped: string) =>
          escaped === "n" ? "\n" : escaped,
        );
      }
    }
    out[key] = value;
  }
  return out;
}

/** Serialize a key/value map into a deterministic `.env` body (sorted keys). */
export function serializeDotenv(vars: Record<string, string>): string {
  const keys = Object.keys(vars).sort();
  const lines = keys.map((key) => {
    const value = vars[key];
    const needsQuote = value === "" || /[\s#"'=]/.test(value) || value.includes("\n");
    if (!needsQuote) return `${key}=${value}`;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return `${key}="${escaped}"`;
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/* ------------------------------------------------------------------ *
 * Read / write encrypted scopes                                       *
 * ------------------------------------------------------------------ */

/** Decrypt and parse a scope's vars, or null when the scope doesn't exist. */
export async function readEnvScope(
  mapDir: string,
  scope: EnvScope,
  key: Buffer,
): Promise<Record<string, string> | null> {
  const file = scopeFilePath(mapDir, scope);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw fileReadError("saved environment data", file, error);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Saved environment data at ${quoteUserValue(file, 500)} is not valid JSON. Restore or replace the file, then retry.`,
    );
  }
  const parsed = encryptedBlobSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Saved environment data at ${quoteUserValue(file, 500)} has an invalid format. Restore or replace the file, then retry.`,
    );
  }
  return parseDotenv(decrypt(parsed.data, key));
}

/** Encrypt and persist a scope's vars (writes an empty file is avoided — pass {} to clear). */
export async function writeEnvScope(
  mapDir: string,
  scope: EnvScope,
  vars: Record<string, string>,
  key: Buffer,
): Promise<void> {
  const file = scopeFilePath(mapDir, scope);
  const blob = encrypt(serializeDotenv(vars), key);
  await writeFileAtomic(file, `${JSON.stringify(blob, null, 2)}\n`);
}

export async function removeEnvScope(mapDir: string, scope: EnvScope): Promise<boolean> {
  const file = scopeFilePath(mapDir, scope);
  try {
    await fs.rm(file);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw new Error(
      `Could not remove saved environment data at ${quoteUserValue(file, 500)}. Check the file and its permissions, then retry.`,
    );
  }
}

/** List the scopes that have stored env files. */
export async function listScopes(mapDir: string): Promise<EnvScope[]> {
  const scopes: EnvScope[] = [];
  if (existsSync(path.join(envDir(mapDir), GLOBAL_SCOPE_FILE))) scopes.push({ type: "global" });

  const reposRoot = path.join(envDir(mapDir), REPO_SCOPE_DIR);
  await walkScopeFiles(reposRoot, reposRoot, scopes);
  return scopes;
}

async function walkScopeFiles(base: string, dir: string, out: EnvScope[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw fileReadError("saved environment directory", dir, error);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkScopeFiles(base, full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      const rel = path.relative(base, full).replace(/\.json$/, "");
      out.push({ type: "repo", relativePath: rel.split(path.sep).join("/") });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Materialise into the workspace                                       *
 * ------------------------------------------------------------------ */

export interface MaterializeResult {
  scope: EnvScope;
  target: string;
  count: number;
}

/** Target `.env` location for a scope within the workspace. */
export function materializeTarget(root: string, scope: EnvScope): string {
  if (scope.type === "global") return path.join(root, DOTENV_FILE);
  return path.join(resolveWithinRoot(root, scope.relativePath), DOTENV_FILE);
}

/**
 * Decrypt every stored scope and write its `.env` into the workspace. Each
 * `.env` is added to the repo's `.git/info/exclude` so it never lands in a
 * commit. Returns what was written.
 */
export async function materializeAll(
  root: string,
  mapDir: string,
  key: Buffer,
): Promise<MaterializeResult[]> {
  const results: MaterializeResult[] = [];
  for (const scope of await listScopes(mapDir)) {
    const vars = await readEnvScope(mapDir, scope, key);
    if (!vars) continue;
    const target = materializeTarget(root, scope);
    await writeFileAtomic(target, serializeDotenv(vars), { mode: 0o600 });
    await excludeDotenvFromGit(path.dirname(target));
    results.push({ scope, target, count: Object.keys(vars).length });
  }
  return results;
}

/** Decrypt scopes only far enough to report which names are available. */
export async function storedEnvironmentNames(mapDir: string, key: Buffer): Promise<Set<string>> {
  const names = new Set<string>();
  for (const scope of await listScopes(mapDir)) {
    const vars = await readEnvScope(mapDir, scope, key);
    for (const name of Object.keys(vars ?? {})) names.add(name);
  }
  return names;
}

/**
 * Materialize only the environment names and repository scopes selected by a
 * Profile. Values never leave this function in its result.
 */
export async function materializeSelected(
  root: string,
  mapDir: string,
  key: Buffer,
  names: Set<string>,
  repositoryPaths: Set<string>,
): Promise<MaterializeResult[]> {
  const results: MaterializeResult[] = [];
  for (const scope of await listScopes(mapDir)) {
    if (scope.type === "repo" && !repositoryPaths.has(scope.relativePath)) continue;
    const vars = await readEnvScope(mapDir, scope, key);
    if (!vars) continue;
    const selected = Object.fromEntries(
      Object.entries(vars).filter(([name]) => names.has(name)),
    );
    if (Object.keys(selected).length === 0) continue;
    const target = materializeTarget(root, scope);
    await writeFileAtomic(target, serializeDotenv(selected), { mode: 0o600 });
    await excludeDotenvFromGit(path.dirname(target));
    results.push({ scope, target, count: Object.keys(selected).length });
  }
  return results;
}

/**
 * Add `.env` to a repo's `.git/info/exclude` so it never gets committed. No-op
 * unless the directory is already a git repo — we must never create a `.git`
 * folder here (that would make a placeholder look hydrated).
 */
export async function excludeDotenvFromGit(repoDir: string): Promise<void> {
  if (!existsSync(path.join(repoDir, ".git"))) return;
  const infoDir = path.join(repoDir, ".git", "info");
  const excludePath = path.join(infoDir, "exclude");
  let current = "";
  try {
    current = await fs.readFile(excludePath, "utf8");
  } catch {
    try {
      await fs.mkdir(infoDir, { recursive: true });
    } catch {
      return; // .git is a file (worktree/submodule) — leave it alone
    }
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(DOTENV_FILE)) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludePath, `${prefix}${DOTENV_FILE}\n`, "utf8");
}
