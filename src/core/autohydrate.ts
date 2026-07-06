import path from "node:path";
import { hydratePlaceholder, type HydrateHooks, type HydrateOutcome } from "./hydrate";
import { isLinked, mapPaths } from "./map";
import { isPlaceholder } from "./placeholder";

/** Whether `child` is `parent` or lives beneath it. */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

/**
 * Walk up from an accessed path to find the nearest placeholder directory,
 * stopping at `stopAt` (defaults to the filesystem root). Returns the
 * placeholder directory, or null when the path is inside a real repo / plain
 * folder. A hydrated repo is never a target (it is no longer a placeholder).
 */
export function nearestPlaceholder(accessedPath: string, stopAt?: string): string | null {
  let current = path.resolve(accessedPath);
  const stop = stopAt ? path.resolve(stopAt) : path.parse(current).root;

  if (!isWithin(stop, current)) return null;

  while (true) {
    if (isPlaceholder(current)) return current;
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Find the nearest boot workspace root (a linked directory) at or above `start`,
 * or null when there isn't one.
 */
export function findWorkspaceRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (isLinked(current)) return mapPaths(current).root;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface AutoHydrateResult {
  hydrated: boolean;
  repoDir?: string;
  outcome?: HydrateOutcome;
}

/**
 * If `accessedPath` lies inside (or is) a placeholder, hydrate it on demand.
 * This is the engine behind "navigate into a folder and it pulls down". A
 * no-op (returns `{ hydrated: false }`) when there's no placeholder to hydrate.
 */
export async function autoHydrate(
  accessedPath: string,
  options: { stopAt?: string; hooks?: HydrateHooks } = {},
): Promise<AutoHydrateResult> {
  const target = nearestPlaceholder(accessedPath, options.stopAt);
  if (!target) return { hydrated: false };

  const outcome = await hydratePlaceholder(target, options.hooks);
  return { hydrated: outcome !== "already-hydrated", repoDir: target, outcome };
}
