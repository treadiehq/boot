import path from "node:path";
import { lstatSync } from "node:fs";
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

/**
 * A repository in a Workspace definition may be the Workspace root itself.
 * Other persisted Boot paths remain non-root to prevent generated state from
 * targeting the whole Workspace accidentally.
 */
export const workspaceRepositoryPathSchema = z.union([
  z.literal("."),
  portableRelativePathSchema,
]);

export type WorkspaceRepositoryPath = z.infer<
  typeof workspaceRepositoryPathSchema
>;

/** Resolve a persisted relative path and prove that it remains under `root`. */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const parsed = portableRelativePathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw new Error(
      `Workspace path ${quoteUserValue(relativePath)} is invalid: ${parsed.error.issues[0]?.message}. Use a relative path inside the workspace.`,
    );
  }

  if (process.platform === "win32" && relativePath.split("/").some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Windows workspace paths cannot use device names, named streams, or ambiguous trailing characters.");
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, ...relativePath.split("/"));
  const rootPrefix = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
  if (target !== absoluteRoot && !target.startsWith(rootPrefix)) {
    throw new Error(
      `Workspace path ${quoteUserValue(relativePath)} points outside the workspace. Use a relative path inside the workspace.`,
    );
  }
  // Reject links at every existing component, including dangling links. A
  // lexical prefix alone does not contain writes through a symlinked parent.
  let current = absoluteRoot;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Workspace path ${quoteUserValue(relativePath)} contains a symlink. Use a physical path inside the workspace.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

/** Resolve a repository path, including the explicit `.` Workspace-root form. */
export function resolveWorkspaceRepositoryPath(
  root: string,
  relativePath: string,
): string {
  const parsed = workspaceRepositoryPathSchema.safeParse(relativePath);
  if (!parsed.success) {
    throw new Error(
      `Workspace repository path ${quoteUserValue(relativePath)} is invalid: ${
        parsed.error.issues[0]?.message
      }. Use "." or a relative path inside the workspace.`,
    );
  }
  return parsed.data === "." ? path.resolve(root) : resolveWithinRoot(root, parsed.data);
}
