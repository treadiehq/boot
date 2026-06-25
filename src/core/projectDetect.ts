import fs from "node:fs/promises";
import path from "node:path";
import { GENERATED_DIRS } from "./pathUtils";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type ProjectType = "node" | "python" | "go" | "rust" | "unknown";

export interface ProjectInfo {
  packageManager: PackageManager | null;
  projectType: ProjectType;
  detectedFiles: string[];
  ignoredHints: string[];
}

/** Marker files we surface in `detectedFiles` to describe a repo at a glance. */
const MARKER_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "bun.lock",
  "tsconfig.json",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "Pipfile",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
] as const;

/** Detect the package manager from lockfiles, falling back to a package.json field. */
export function detectPackageManager(
  names: Set<string>,
  packageManagerField?: string | null,
): PackageManager | null {
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  if (names.has("package-lock.json")) return "npm";

  if (packageManagerField) {
    const pm = packageManagerField.split("@")[0];
    if (pm === "pnpm" || pm === "npm" || pm === "yarn" || pm === "bun") return pm;
  }
  return null;
}

/** Detect the broad project type from well-known marker files. */
export function detectProjectType(names: Set<string>): ProjectType {
  if (names.has("package.json")) return "node";
  if (
    names.has("pyproject.toml") ||
    names.has("requirements.txt") ||
    names.has("setup.py") ||
    names.has("Pipfile")
  ) {
    return "python";
  }
  if (names.has("go.mod")) return "go";
  if (names.has("Cargo.toml")) return "rust";
  return "unknown";
}

async function listNames(dir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return new Set(entries.map((e) => e.name));
  } catch {
    return new Set();
  }
}

/** Inspect a repo's top-level files to infer language, tooling, and ignore hints. */
export async function detectProject(repoPath: string): Promise<ProjectInfo> {
  const names = await listNames(repoPath);

  let packageManagerField: string | null = null;
  if (names.has("package.json")) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(repoPath, "package.json"), "utf8"));
      if (typeof pkg?.packageManager === "string") {
        packageManagerField = pkg.packageManager;
      }
    } catch {
      // malformed package.json — ignore and fall back to lockfile detection
    }
  }

  return {
    packageManager: detectPackageManager(names, packageManagerField),
    projectType: detectProjectType(names),
    detectedFiles: MARKER_FILES.filter((f) => names.has(f)).sort(),
    ignoredHints: GENERATED_DIRS.filter((d) => names.has(d)).sort(),
  };
}
