import { windowsUserSid, protectWindowsStore } from "./sessionWindows";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { stateDir } from "./identity";
import { writeFileAtomic } from "./files";
import { withFileLock } from "./lock";
import { resolveWithinRoot } from "./pathUtils";
import { workspaceDefinitionSchema } from "./workspace";
import { sessionRuntimeSchema } from "./sessionRuntimeState";

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const sessionRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), name: z.string(),
  owner: z.object({ uid: z.number().nullable(), host: z.string(), sid: z.string().optional() }).strict(),
  store: z.string(), root: z.string(), sourceRoot: z.string(),
  createdAt: z.string(), updatedAt: z.string(),
  state: z.enum(["provisioning", "ready", "running", "released", "failed", "deleting"]),
  definition: workspaceDefinitionSchema,
  includeWorkingTree: z.boolean(),
  repositories: z.array(z.object({
    id: z.string(), relativePath: z.string(), source: z.string(), base: sha,
    snapshot: sha.optional(), submoduleOf: z.string().optional(), gitlinkPath: z.string().optional(),
    sourceRef: z.string().nullable(), seed: z.string().regex(/^[a-f0-9]{64}$/),
    branch: z.string(), backend: z.enum(["apfs-clone", "linux-reflink", "refs-clone", "worktree", "clone"]),
    fallbackReason: z.string().nullable(), importedChanges: z.boolean(),
    excludedChanges: z.array(z.string()),
    includes: z.array(z.object({ path: z.string(), fingerprint: z.string() }).strict()),
  }).strict()),
  launch: z.object({ supervisor: z.number(), pid: z.number().nullable(), group: z.boolean(), startedAt: z.string(), finished: z.boolean() }).strict().nullable(),
  externalOwner: z.string().nullable(),
  lastExit: z.object({ code: z.number().nullable(), signal: z.string().nullable() }).strict().nullable(),
  failure: z.string().nullable(),
  runtime: sessionRuntimeSchema.optional(),
}).strict();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionRepository = SessionRecord["repositories"][number];

export const sessionOwner = () => ({ uid: process.getuid?.() ?? null, host: os.hostname(), ...(process.platform === "win32" ? { sid: windowsUserSid() } : {}) });

export async function readJson(file: string): Promise<unknown | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error("Boot metadata must be a regular file.");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function verifyStore(store: string): Promise<void> {
  const stat = await fs.lstat(store);
  if (!stat.isDirectory() || await fs.realpath(store) !== store) throw new Error("Session store must be a physical directory, without symlinks.");
  if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) throw new Error("Session store ownership or permissions are unsafe; it must be owned by this user and not writable by others.");
  if (process.platform === "win32") await protectWindowsStore(store, false);
}

export async function ensureStore(input: string): Promise<string> {
  const created = await fs.mkdir(input, { recursive: true, mode: 0o700 });
  const store = await fs.realpath(input);
  if (process.platform === "win32" && created !== undefined) await protectWindowsStore(store, true);
  await verifyStore(store);
  await fs.mkdir(resolveWithinRoot(store, "sessions"), { recursive: true, mode: 0o700 });
  await fs.mkdir(resolveWithinRoot(store, "seeds"), { recursive: true, mode: 0o700 });
  // The registry contains paths only. Registration happens before provisioning
  // so an interrupted attempt remains discoverable.
  await withFileLock(path.join(stateDir(), "session-registry.lock"), "registering a session store", async () => {
    const file = path.join(stateDir(), "session-stores.json");
    const existing = z.object({ schemaVersion: z.literal(1), stores: z.array(z.string()) }).parse(await readJson(file) ?? { schemaVersion: 1, stores: [] });
    await writeFileAtomic(file, JSON.stringify({ ...existing, stores: [...new Set([...existing.stores, store])] }), { mode: 0o600 });
  }, { staleAfterMs: 1000 });
  return store;
}

export async function registeredStores(store?: string): Promise<string[]> {
  if (store) return [await fs.realpath(store)];
  const data = z.object({ schemaVersion: z.literal(1), stores: z.array(z.string()) }).parse(await readJson(path.join(stateDir(), "session-stores.json")) ?? { schemaVersion: 1, stores: [] });
  return data.stores;
}

export function recordPath(store: string, id: string): string {
  z.string().uuid().parse(id);
  return resolveWithinRoot(store, `sessions/${id}/session.json`);
}

export async function verifyRecord(record: SessionRecord): Promise<void> {
  await verifyStore(record.store);
  const expected = resolveWithinRoot(record.store, `sessions/${record.id}/workspace`);
  if (record.root !== expected || record.owner.host !== os.hostname() || record.owner.uid !== (process.getuid?.() ?? null) || (process.platform === "win32" && record.owner.sid !== windowsUserSid())) {
    throw new Error("Session ownership or physical path containment cannot be verified.");
  }
  const marker = await readJson(resolveWithinRoot(record.store, `sessions/${record.id}/owner.json`));
  if (JSON.stringify(marker) !== JSON.stringify({ id: record.id, owner: record.owner })) throw new Error("Session ownership marker is missing or does not match.");
}

export async function writeSession(record: SessionRecord): Promise<void> {
  await verifyRecord(record);
  record.updatedAt = new Date().toISOString();
  await writeFileAtomic(recordPath(record.store, record.id), JSON.stringify(sessionRecordSchema.parse(record), null, 2) + "\n", { mode: 0o600 });
}

export async function listSessionRecords(store?: string): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for (const location of await registeredStores(store)) {
    try { await fs.lstat(location); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await verifyStore(location);
    for (const entry of await fs.readdir(resolveWithinRoot(location, "sessions"))) {
      if (!z.string().uuid().safeParse(entry).success) throw new Error("Unrecognized session directory; cleanup requires manual inspection.");
      const data = await readJson(recordPath(location, entry));
      if (!data) throw new Error(`Session ${entry} has incomplete metadata; retain it for manual inspection.`);
      const record = sessionRecordSchema.parse(data);
      if (record.store !== location || record.id !== entry) throw new Error("Session metadata does not match its store.");
      await verifyRecord(record);
      records.push(record);
    }
  }
  return records;
}

export async function findSession(selector: string, store?: string): Promise<SessionRecord> {
  const matches = (await listSessionRecords(store)).filter((record) => record.id === selector || record.name === selector);
  if (matches.length !== 1) throw new Error(matches.length ? "Session name is ambiguous; use its full ID." : "Session not found. Use boot session list or --store to locate it.");
  return matches[0]!;
}

export async function withStoreLock<T>(store: string, fn: () => Promise<T>): Promise<T> {
  await verifyStore(store);
  return withFileLock(resolveWithinRoot(store, "sessions.lock"), "updating managed sessions", fn, { staleAfterMs: 1000, timeoutMs: 60_000 });
}
