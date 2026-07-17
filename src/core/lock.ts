import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pidAlive } from "./daemonState";
import { BOOT_DIR_NAME } from "./map";

export interface LockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
}

interface LockTiming {
  deadline: number;
  staleAfterMs: number;
}

const RETRY_MS = 100;
const GUARD_OWNER_PREFIX = "owner-";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sleep(ms = RETRY_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(label: string): Error {
  return new Error(
    `Timed out waiting for another Boot process to finish ${label}. Wait for that process to finish, then retry.`,
  );
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readOrNull(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function ownerIsAlive(ownerText: string): boolean {
  const ownerPid = Number.parseInt(ownerText.trim(), 10);
  return Number.isSafeInteger(ownerPid) && ownerPid > 0 && pidAlive(ownerPid);
}

async function removeEmptyDirectory(target: string): Promise<boolean> {
  try {
    await fs.rmdir(target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Try to create the short-lived acquisition guard. A unique marker makes stale
 * cleanup generation-safe: cleanup removes only the marker it observed, and
 * `rmdir` cannot remove a guard after a new owner marker has appeared.
 */
async function tryCreateGuard(guardPath: string): Promise<string | null> {
  try {
    await fs.mkdir(guardPath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return null;
    throw error;
  }

  const ownerName = `${GUARD_OWNER_PREFIX}${process.pid}-${randomUUID()}`;
  const ownerPath = path.join(guardPath, ownerName);
  try {
    await fs.writeFile(ownerPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

    // A delayed stale reaper may have removed and recreated the directory
    // between mkdir and writeFile. Only the sole marker owns this generation.
    const owners = (await fs.readdir(guardPath)).filter((name) =>
      name.startsWith(GUARD_OWNER_PREFIX),
    );
    if (owners.length === 1 && owners[0] === ownerName) return ownerPath;

    await fs.rm(ownerPath, { force: true });
    await removeEmptyDirectory(guardPath);
    return null;
  } catch (error) {
    await fs.rm(ownerPath, { force: true }).catch(() => undefined);
    await removeEmptyDirectory(guardPath).catch(() => undefined);
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function reapStaleGuard(guardPath: string, staleAfterMs: number): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(guardPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }

  const owners = entries.filter(
    (entry) => entry.isFile() && entry.name.startsWith(GUARD_OWNER_PREFIX),
  );
  if (owners.length === 0) {
    const stat = await statOrNull(guardPath);
    if (!stat || Date.now() - stat.mtimeMs > staleAfterMs) {
      return removeEmptyDirectory(guardPath);
    }
    return false;
  }

  const staleOwnerPaths: string[] = [];
  for (const owner of owners) {
    const ownerPath = path.join(guardPath, owner.name);
    const stat = await statOrNull(ownerPath);
    if (!stat) continue;
    if (Date.now() - stat.mtimeMs <= staleAfterMs) return false;

    const ownerText = await readOrNull(ownerPath);
    if (ownerText !== null && ownerIsAlive(ownerText)) return false;
    staleOwnerPaths.push(ownerPath);
  }

  for (const ownerPath of staleOwnerPaths) {
    await fs.rm(ownerPath, { force: true });
  }
  return removeEmptyDirectory(guardPath);
}

async function acquireGuard(
  guardPath: string,
  label: string,
  timing: LockTiming,
): Promise<string> {
  while (Date.now() < timing.deadline) {
    const ownerPath = await tryCreateGuard(guardPath);
    if (ownerPath) return ownerPath;
    if (await reapStaleGuard(guardPath, timing.staleAfterMs)) continue;
    await sleep();
  }
  throw timeoutError(label);
}

async function releaseGuard(guardPath: string, ownerPath: string): Promise<void> {
  await fs.rm(ownerPath, { force: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await removeEmptyDirectory(guardPath)) return;
    await sleep(10);
  }
}

async function createOwnerFile(lockPath: string, ownerText: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(ownerText, "utf8");
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    await handle?.close().catch(() => undefined);
    handle = undefined;
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Called only while the acquisition guard is held. */
async function claimOwnerFile(
  lockPath: string,
  ownerText: string,
  staleAfterMs: number,
): Promise<boolean> {
  if (await createOwnerFile(lockPath, ownerText)) return true;

  const stat = await statOrNull(lockPath);
  if (!stat) return createOwnerFile(lockPath, ownerText);
  if (!stat.isFile()) {
    throw new Error(`Boot lock path is not a file: ${lockPath}`);
  }
  if (Date.now() - stat.mtimeMs <= staleAfterMs) return false;

  const existingOwner = await readOrNull(lockPath);
  if (existingOwner !== null && ownerIsAlive(existingOwner)) return false;

  await fs.rm(lockPath, { force: true });
  return createOwnerFile(lockPath, ownerText);
}

async function releaseOwnerFile(
  lockPath: string,
  guardPath: string,
  ownerText: string,
  label: string,
  timeoutMs: number,
  staleAfterMs: number,
): Promise<void> {
  const timing = { deadline: Date.now() + timeoutMs, staleAfterMs };
  const guardOwner = await acquireGuard(guardPath, label, timing);
  try {
    const currentOwner = await readOrNull(lockPath);
    if (currentOwner === null) {
      throw new Error(`Boot lock disappeared while ${label}.`);
    }
    if (currentOwner !== ownerText) {
      throw new Error(`Boot lock ownership changed while ${label}.`);
    }
    await fs.rm(lockPath, { force: true });
  } finally {
    await releaseGuard(guardPath, guardOwner);
  }
}

/** Run an operation while holding a cross-process filesystem lock. */
export async function withFileLock<T>(
  lockPath: string,
  label: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const staleAfterMs = options.staleAfterMs ?? 30 * 60_000;
  const timing = { deadline: Date.now() + timeoutMs, staleAfterMs };
  const guardPath = `${lockPath}.guard`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() < timing.deadline) {
    const ownerText = `${process.pid} ${randomUUID()}\n`;
    const guardOwner = await acquireGuard(guardPath, label, timing);
    let claimed = false;
    try {
      claimed = await claimOwnerFile(lockPath, ownerText, staleAfterMs);
    } finally {
      await releaseGuard(guardPath, guardOwner);
    }

    if (!claimed) {
      await sleep();
      continue;
    }

    try {
      return await operation();
    } finally {
      await releaseOwnerFile(lockPath, guardPath, ownerText, label, timeoutMs, staleAfterMs);
    }
  }

  throw timeoutError(label);
}

export function withWorkspaceMapLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(
    path.join(path.resolve(root), BOOT_DIR_NAME, "map.lock"),
    "updating workspace data",
    operation,
  );
}
