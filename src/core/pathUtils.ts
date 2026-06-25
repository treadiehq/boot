import path from "node:path";

/**
 * Generated / build-output directories that boot should never descend into
 * while scanning, and which it records as "ignoredHints" so they can be excluded
 * from a future sync. (`.git` is handled separately by the scanner.)
 */
export const GENERATED_DIRS = [
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "vendor",
  ".turbo",
  ".cache",
] as const;

/**
 * Directories the scanner must skip entirely while walking a workspace.
 * This is the generated set plus `.git` itself.
 */
export const SKIP_DIRS = new Set<string>([...GENERATED_DIRS, ".git"]);

/** Convert a platform path into a stable, portable posix-style path. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Relative path from `root` to `target`, always expressed with forward slashes
 * so manifests stay portable across operating systems.
 */
export function toPosixRelative(root: string, target: string): string {
  return toPosix(path.relative(root, target));
}
