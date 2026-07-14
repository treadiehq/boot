import path from "node:path";
import { z } from "zod";
import { quoteUserValue } from "./userErrors";

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

/**
 * A portable path stored in Boot state. Persisted paths are always relative to
 * the workspace root and use POSIX separators on every platform.
 */
export const portableRelativePathSchema = z.string().superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not be empty" });
    return;
  }
  if (value.includes("\0")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain NUL bytes" });
  }
  if (value.includes("\\")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must use forward slashes" });
  }
  if (value === "." || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a non-root path relative to the workspace",
    });
  }
  if (path.posix.normalize(value) !== value || value.split("/").some((part) => part === "..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be normalized and must not contain '..'",
    });
  }
});

export type PortableRelativePath = z.infer<typeof portableRelativePathSchema>;

/** Resolve a persisted relative path and prove that it remains under `root`. */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const parsed = portableRelativePathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw new Error(
      `Workspace path ${quoteUserValue(relativePath)} is invalid: ${parsed.error.issues[0]?.message}. Use a relative path inside the workspace.`,
    );
  }

  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (!target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(
      `Workspace path ${quoteUserValue(relativePath)} points outside the workspace. Use a relative path inside the workspace.`,
    );
  }
  return target;
}
