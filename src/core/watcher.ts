import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import { autoHydrate } from "./autohydrate";
import { scanWorkspace } from "./scanner";

/** List the absolute paths of every placeholder repo in a workspace. */
export async function listPlaceholders(root: string): Promise<string[]> {
  const scan = await scanWorkspace(root);
  return scan.repos
    .filter((repo) => repo.hydrate.status === "placeholder")
    .map((repo) => path.resolve(repo.absolutePath));
}

/**
 * Pure mapping from a changed filesystem path to the placeholder that owns it.
 * Returns the matching placeholder directory, or null when the path isn't
 * inside any placeholder.
 */
export function placeholderForEvent(eventPath: string, placeholders: string[]): string | null {
  const abs = path.resolve(eventPath);
  for (const p of placeholders) {
    const dir = path.resolve(p);
    if (abs === dir || abs.startsWith(`${dir}${path.sep}`)) return dir;
  }
  return null;
}

export interface WatchHooks {
  onReady?(placeholders: string[], mode: "recursive" | "per-dir"): void;
  onActivity?(repoDir: string): void;
  onHydrated?(repoDir: string): void;
  onError?(err: Error): void;
}

export interface WatchOptions {
  debounceMs?: number;
}

export interface Watcher {
  /** Placeholder directories currently armed for hydration. */
  readonly armed: readonly string[];
  close(): Promise<void>;
}

/**
 * Watch a workspace's placeholder directories and hydrate one as soon as write
 * activity lands inside it. Uses a single recursive watcher where the platform
 * supports it (macOS/Windows) and falls back to one watcher per placeholder on
 * Linux. A placeholder is disarmed once hydrated so the clone's own writes can't
 * re-trigger it.
 */
export async function startWatcher(
  root: string,
  hooks: WatchHooks = {},
  options: WatchOptions = {},
): Promise<Watcher> {
  const absRoot = path.resolve(root);
  const debounceMs = options.debounceMs ?? 400;

  const placeholders = await listPlaceholders(absRoot);
  const active = new Set(placeholders);
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();

  function scheduleHydrate(repoDir: string): void {
    if (!active.has(repoDir)) return;
    hooks.onActivity?.(repoDir);
    const existing = timers.get(repoDir);
    if (existing) clearTimeout(existing);
    timers.set(
      repoDir,
      setTimeout(() => {
        timers.delete(repoDir);
        if (!active.has(repoDir)) return;
        // Disarm before hydrating so the clone's writes don't re-enter.
        active.delete(repoDir);
        autoHydrate(repoDir, { stopAt: absRoot })
          .then((result) => {
            if (result.hydrated) hooks.onHydrated?.(repoDir);
          })
          .catch((err: Error) => {
            hooks.onError?.(err);
            // Re-arm so a later access can retry.
            active.add(repoDir);
          });
      }, debounceMs),
    );
  }

  let mode: "recursive" | "per-dir" = "recursive";
  try {
    const rootWatcher = fsWatch(absRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const abs = path.resolve(absRoot, filename.toString());
      const target = placeholderForEvent(abs, [...active]);
      if (target) scheduleHydrate(target);
    });
    watchers.push(rootWatcher);
  } catch {
    // Recursive watching isn't available (Linux) — watch each placeholder dir.
    mode = "per-dir";
    for (const dir of active) {
      try {
        watchers.push(fsWatch(dir, () => scheduleHydrate(dir)));
      } catch (err) {
        hooks.onError?.(err as Error);
      }
    }
  }

  hooks.onReady?.([...active], mode);

  return {
    get armed() {
      return [...active];
    },
    async close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const w of watchers) w.close();
    },
  };
}
