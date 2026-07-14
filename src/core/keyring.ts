import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./files";
import { wrappedKeySchema, type WrappedKey } from "./secrets";
import { fileReadError, isFileNotFoundError, quoteUserValue } from "./userErrors";

/**
 * The keyring lives in the synced map and holds the workspace's secret key,
 * each entry encrypted under a passphrase. It's safe to sync: without the
 * passphrase the entries are inert. New machines unwrap an entry instead of
 * hand-copying the raw key.
 */
export const KEYRING_FILE = "keyring.json";

export const keyringEntrySchema = z.object({
  /** Free-text label (hostname that shared it, "team", …) for humans. */
  label: z.string(),
  createdAt: z.string(),
  wrapped: wrappedKeySchema,
});

export type KeyringEntry = z.infer<typeof keyringEntrySchema>;

export const keyringSchema = z.object({
  v: z.literal(1),
  entries: z.array(keyringEntrySchema),
});

export type Keyring = z.infer<typeof keyringSchema>;

function keyringPath(mapDir: string): string {
  return path.join(mapDir, KEYRING_FILE);
}

export async function readKeyring(mapDir: string): Promise<Keyring | null> {
  const filePath = keyringPath(mapDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw fileReadError("shared key data", filePath, error);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Shared key data at ${quoteUserValue(filePath, 500)} is not valid JSON. Restore or replace the file, then retry.`,
    );
  }
  const parsed = keyringSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Shared key data at ${quoteUserValue(filePath, 500)} has an invalid format. Restore or replace the file, then retry.`,
    );
  }
  return parsed.data;
}

export async function writeKeyring(mapDir: string, keyring: Keyring): Promise<void> {
  const validated = keyringSchema.parse(keyring);
  await writeFileAtomic(keyringPath(mapDir), `${JSON.stringify(validated, null, 2)}\n`);
}

/** True when the map already contains a wrapped key (the signal to `receive`). */
export async function hasKeyringEntry(mapDir: string): Promise<boolean> {
  const keyring = await readKeyring(mapDir);
  return Boolean(keyring && keyring.entries.length > 0);
}

/**
 * Add (or replace) a wrapped-key entry. We keep a single entry per label so
 * re-sharing from the same machine overwrites rather than piling up.
 */
export async function upsertKeyringEntry(mapDir: string, entry: KeyringEntry): Promise<void> {
  const keyring = (await readKeyring(mapDir)) ?? { v: 1 as const, entries: [] };
  const next = keyring.entries.filter((e) => e.label !== entry.label);
  next.push(entry);
  await writeKeyring(mapDir, { v: 1, entries: next });
}

/** Remove every entry with `label`. Returns how many were removed. */
export async function removeKeyringEntry(mapDir: string, label: string): Promise<number> {
  const keyring = await readKeyring(mapDir);
  if (!keyring) return 0;
  const kept = keyring.entries.filter((e) => e.label !== label);
  const removed = keyring.entries.length - kept.length;
  if (removed > 0) await writeKeyring(mapDir, { v: 1, entries: kept });
  return removed;
}

/** Labels on wrapped keys currently stored in the keyring. */
export async function listKeyringLabels(mapDir: string): Promise<string[]> {
  const keyring = await readKeyring(mapDir);
  return keyring ? keyring.entries.map((e) => e.label) : [];
}

/** The most recently added entry, or null. */
export function latestEntry(keyring: Keyring | null): KeyringEntry | null {
  if (!keyring || keyring.entries.length === 0) return null;
  return keyring.entries.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
}

/** Re-export for callers that only need the wrapped shape. */
export type { WrappedKey };
