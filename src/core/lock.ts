import fs from "node:fs/promises";
import path from "node:path";
import { pidAlive } from "./daemonState";
import { BOOT_DIR_NAME } from "./map";

export interface LockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
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
  const started = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - started < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      try {
        return await operation();
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleAfterMs) {
        const ownerText = await fs.readFile(lockPath, "utf8").catch(() => "");
        const ownerPid = Number.parseInt(ownerText.trim(), 10);
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && pidAlive(ownerPid)) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        await fs.rm(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(
    `Timed out waiting for another Boot process to finish ${label}. Wait for that process to finish, then retry.`,
  );
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
