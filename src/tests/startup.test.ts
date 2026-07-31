import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServices, type ServiceStartEvent } from "../core/startup";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-startup-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Health check that passes once `ready.txt` exists in the workspace root. */
const checkReadyFile = `node -e "process.exit(require('fs').existsSync('ready.txt') ? 0 : 1)"`;
/** Start command that creates `ready.txt`, making the check pass. */
const startReadyFile = `node -e "require('fs').writeFileSync('ready.txt', 'ok')"`;

describe("startServices", () => {
  it("does not run the start command when the service is already healthy", async () => {
    await fs.writeFile(path.join(root, "ready.txt"), "ok");
    const results = await startServices(root, {
      db: {
        check: checkReadyFile,
        start: `node -e "require('fs').writeFileSync('started.txt', 'oops')"`,
      },
    });

    expect(results).toEqual([
      expect.objectContaining({ name: "db", action: "already-available" }),
    ]);
    expect(existsSync(path.join(root, "started.txt"))).toBe(false);
  });

  it("starts an unhealthy service and waits until its check passes", async () => {
    const events: ServiceStartEvent[] = [];
    const results = await startServices(
      root,
      { db: { check: checkReadyFile, start: startReadyFile } },
      { onEvent: (event) => events.push(event), pollIntervalMs: 25 },
    );

    expect(results).toEqual([
      expect.objectContaining({
        name: "db",
        action: "started",
        status: expect.objectContaining({ state: "available" }),
      }),
    ]);
    expect(events.map((event) => event.phase)).toEqual(["starting", "waiting", "ready"]);
  });

  it("skips services that declare no start command", async () => {
    const results = await startServices(root, { db: { check: checkReadyFile } });

    expect(results).toEqual([
      expect.objectContaining({
        name: "db",
        action: "skipped",
        detail: expect.stringContaining("no start command"),
      }),
    ]);
  });

  it("fails when the start command exits with an error", async () => {
    const results = await startServices(root, {
      db: { check: checkReadyFile, start: `node -e "process.exit(3)"` },
    });

    expect(results).toEqual([
      expect.objectContaining({
        name: "db",
        action: "failed",
        detail: expect.stringContaining("exited with status 3"),
      }),
    ]);
  });

  it("fails when the service never reports healthy before the timeout", async () => {
    const results = await startServices(
      root,
      {
        db: {
          check: checkReadyFile,
          start: `node -e ""`,
          readyTimeoutSeconds: 1,
        },
      },
      { pollIntervalMs: 25 },
    );

    expect(results).toEqual([
      expect.objectContaining({
        name: "db",
        action: "failed",
        detail: expect.stringContaining("did not report healthy within 1s"),
      }),
    ]);
  });
});
