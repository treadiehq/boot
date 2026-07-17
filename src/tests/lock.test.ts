import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../core/lock";

let root: string;
let lockPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-lock-test-"));
  lockPath = path.join(root, "operation.lock");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeOldLock(pid: number): Promise<void> {
  await fs.writeFile(lockPath, `${pid}\n`, "utf8");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);
}

describe("withFileLock", () => {
  it("does not reclaim an old lock while its owner is alive", async () => {
    await writeOldLock(process.pid);
    const operation = vi.fn(async () => undefined);

    await expect(
      withFileLock(lockPath, "test operation", operation, {
        timeoutMs: 20,
        staleAfterMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for another Boot process");

    expect(operation).not.toHaveBeenCalled();
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(`${process.pid}\n`);
  });

  it("reclaims an old lock after its owner exits", async () => {
    await writeOldLock(2_000_000_000);

    const owner = await withFileLock(
      lockPath,
      "test operation",
      async () => fs.readFile(lockPath, "utf8"),
      { timeoutMs: 20, staleAfterMs: 10 },
    );

    expect(owner).toBe(`${process.pid}\n`);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
