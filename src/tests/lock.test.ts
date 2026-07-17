import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

async function writeOldGuard(pid: number): Promise<void> {
  const guardPath = `${lockPath}.guard`;
  const ownerPath = path.join(guardPath, `owner-${pid}-stale`);
  await fs.mkdir(guardPath);
  await fs.writeFile(ownerPath, `${pid}\n`, "utf8");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(ownerPath, old, old);
  await fs.utimes(guardPath, old, old);
}

function runWorker(workerPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lock worker exited with code ${code}: ${stderr.trim()}`));
    });
  });
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

    expect(owner).toMatch(new RegExp(`^${process.pid} [0-9a-f-]+\\n$`));
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${lockPath}.guard`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an abandoned acquisition guard", async () => {
    await writeOldGuard(2_000_000_000);

    await expect(
      withFileLock(lockPath, "test operation", async () => "done", {
        timeoutMs: 1_000,
        staleAfterMs: 10,
      }),
    ).resolves.toBe("done");

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${lockPath}.guard`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(
    "serializes processes that concurrently reclaim a stale lock",
    async () => {
      await writeOldLock(2_000_000_000);
      const eventsPath = path.join(root, "events.log");
      const workerPath = path.join(root, "lock-worker.mjs");
      const lockModuleUrl = pathToFileURL(path.resolve("src/core/lock.ts")).href;
      await fs.writeFile(
        workerPath,
        [
          'import fs from "node:fs/promises";',
          "const [moduleUrl, lockPath, eventsPath, startAtText] = process.argv.slice(2);",
          "const { withFileLock } = await import(moduleUrl);",
          "const startAt = Number(startAtText);",
          "if (Date.now() < startAt) {",
          "  await new Promise((resolve) => setTimeout(resolve, startAt - Date.now()));",
          "}",
          'await withFileLock(lockPath, "race test", async () => {',
          '  await fs.appendFile(eventsPath, `enter ${process.pid}\\n`, "utf8");',
          "  await new Promise((resolve) => setTimeout(resolve, 75));",
          '  await fs.appendFile(eventsPath, `exit ${process.pid}\\n`, "utf8");',
          "}, { timeoutMs: 10_000, staleAfterMs: 10 });",
          "",
        ].join("\n"),
      );

      const workerCount = 6;
      const startAt = String(Date.now() + 1_000);
      await Promise.all(
        Array.from({ length: workerCount }, () =>
          runWorker(workerPath, [lockModuleUrl, lockPath, eventsPath, startAt]),
        ),
      );

      const events = (await fs.readFile(eventsPath, "utf8")).trim().split("\n");
      let active = 0;
      let maxActive = 0;
      let completed = 0;
      for (const event of events) {
        if (event.startsWith("enter ")) {
          active += 1;
          maxActive = Math.max(maxActive, active);
        } else if (event.startsWith("exit ")) {
          active -= 1;
          completed += 1;
        }
      }

      expect(completed).toBe(workerCount);
      expect(active).toBe(0);
      expect(maxActive).toBe(1);
    },
    15_000,
  );
});
