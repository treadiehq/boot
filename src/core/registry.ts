import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stateDir } from "./identity";
import { fileReadError, isFileNotFoundError } from "./userErrors";

/**
 * Machine-global registry of workspaces Boot has touched. It powers
 * cross-workspace surfaces such as `boot ui`. Entries are recorded by
 * `boot init`, `boot up`, and `boot ui`; the file lives in `stateDir()`
 * so tests can isolate it with `BOOT_HOME`.
 */

export const REGISTRY_VERSION = 1 as const;

export const registryEntrySchema = z.object({
  /** Absolute workspace root. Unique key of the registry. */
  root: z.string().min(1),
  /** Workspace display name from boot.yaml, when known. */
  name: z.string().min(1).nullable(),
  lastUsedAt: z.string().min(1),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

const registryFileSchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  workspaces: z.array(registryEntrySchema),
});

type RegistryFile = z.infer<typeof registryFileSchema>;

export function registryPath(): string {
  return path.join(stateDir(), "workspaces.json");
}

async function readRegistry(): Promise<RegistryFile> {
  const file = registryPath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return { version: REGISTRY_VERSION, workspaces: [] };
    throw fileReadError("workspace registry", file, error);
  }
  try {
    const parsed = registryFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Corrupt registry — fall through and start fresh rather than blocking.
  }
  return { version: REGISTRY_VERSION, workspaces: [] };
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  const file = registryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/** Upsert a workspace into the registry, keyed by its absolute root. */
export async function recordWorkspace(root: string, name?: string | null): Promise<void> {
  const absolute = path.resolve(root);
  const registry = await readRegistry();
  const existing = registry.workspaces.find((entry) => entry.root === absolute);
  const entry: RegistryEntry = {
    root: absolute,
    name: name ?? existing?.name ?? null,
    lastUsedAt: new Date().toISOString(),
  };
  registry.workspaces = [
    entry,
    ...registry.workspaces.filter((candidate) => candidate.root !== absolute),
  ];
  await writeRegistry(registry);
}

/** All registered workspaces, most recently used first. */
export async function listWorkspaces(): Promise<Array<RegistryEntry & { exists: boolean }>> {
  const registry = await readRegistry();
  return registry.workspaces.map((entry) => ({
    ...entry,
    exists: existsSync(entry.root),
  }));
}

/** Whether an absolute root is present in the registry. */
export async function isRegisteredWorkspace(root: string): Promise<boolean> {
  const absolute = path.resolve(root);
  const registry = await readRegistry();
  return registry.workspaces.some((entry) => entry.root === absolute);
}

/** Remove a workspace from the registry. No-op when absent. */
export async function removeWorkspace(root: string): Promise<void> {
  const absolute = path.resolve(root);
  const registry = await readRegistry();
  const remaining = registry.workspaces.filter((entry) => entry.root !== absolute);
  if (remaining.length !== registry.workspaces.length) {
    await writeRegistry({ ...registry, workspaces: remaining });
  }
}
