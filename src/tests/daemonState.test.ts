import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearDaemonPid,
  isDaemonRunning,
  pidAlive,
  readDaemonState,
  writeDaemonState,
  type DaemonState,
} from "../core/daemonState";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-daemon-state-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const sample: DaemonState = {
  pid: process.pid,
  startedAt: "2024-01-01T00:00:00.000Z",
  intervalSeconds: 60,
  lastTickAt: null,
  lastTick: null,
};

describe("daemon state", () => {
  it("round-trips through write + read", async () => {
    await writeDaemonState(root, sample);
    const loaded = await readDaemonState(root);
    expect(loaded).toEqual(sample);
  });

  it("returns null when no state exists", async () => {
    expect(await readDaemonState(root)).toBeNull();
  });

  it("clearDaemonPid nulls the pid but keeps the rest", async () => {
    await writeDaemonState(root, { ...sample, lastTickAt: "2024-01-02T00:00:00.000Z" });
    await clearDaemonPid(root);
    const loaded = await readDaemonState(root);
    expect(loaded?.pid).toBeNull();
    expect(loaded?.lastTickAt).toBe("2024-01-02T00:00:00.000Z");
  });
});

describe("pidAlive / isDaemonRunning", () => {
  it("detects the current process as alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("treats an unused pid as dead", () => {
    // A very high pid is exceedingly unlikely to be in use.
    expect(pidAlive(2_000_000_000)).toBe(false);
  });

  it("isDaemonRunning requires a live pid", () => {
    expect(isDaemonRunning(null)).toBe(false);
    expect(isDaemonRunning({ ...sample, pid: null })).toBe(false);
    expect(isDaemonRunning({ ...sample, pid: 2_000_000_000 })).toBe(false);
    expect(isDaemonRunning({ ...sample, pid: process.pid })).toBe(true);
  });
});
