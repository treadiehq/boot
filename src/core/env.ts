import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { decrypt, encrypt, encryptedBlobSchema } from "./secrets";

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
  return path.join(envDir(mapDir), REPO_SCOPE_DIR, `${scope.relativePath}.json`);
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
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
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
  } catch {
    return null;
  }
  const blob = encryptedBlobSchema.parse(JSON.parse(raw));
  return parseDotenv(decrypt(blob, key));
}

/** Encrypt and persist a scope's vars (writes an empty file is avoided — pass {} to clear). */
export async function writeEnvScope(
  mapDir: string,
  scope: EnvScope,
  vars: Record<string, string>,
  key: Buffer,
): Promise<void> {
  const file = scopeFilePath(mapDir, scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const blob = encrypt(serializeDotenv(vars), key);
  await fs.writeFile(file, `${JSON.stringify(blob, null, 2)}\n`, "utf8");
}

export async function removeEnvScope(mapDir: string, scope: EnvScope): Promise<boolean> {
  const file = scopeFilePath(mapDir, scope);
  try {
    await fs.rm(file);
    return true;
  } catch {
    return false;
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
  } catch {
    return;
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
  return path.join(root, scope.relativePath, DOTENV_FILE);
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
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, serializeDotenv(vars), "utf8");
    await excludeDotenvFromGit(path.dirname(target));
    results.push({ scope, target, count: Object.keys(vars).length });
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
