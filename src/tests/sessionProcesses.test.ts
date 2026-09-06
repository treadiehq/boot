import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { sessionFixture } from "./sessionFixture";
import { createSession, gcSessions, releaseSession } from "../core/sessions";
import { runSession } from "../core/sessionRun";
import { findSession } from "../core/sessionStore";
import * as sessionStore from "../core/sessionStore";

let fixture: Awaited<ReturnType<typeof sessionFixture>>;
beforeEach(async () => { fixture = await sessionFixture(); vi.stubEnv("BOOT_HOME", fixture.home); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.root, { recursive: true, force: true }); });

describe("session process ownership", () => {
  it("forwards cancellation while the launched PID is still being persisted", async () => {
    const session = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const write = sessionStore.writeSession;
    let pid: number | null = null;
    vi.spyOn(sessionStore, "writeSession").mockImplementation(async (record) => {
      if (record.launch?.pid && !pid) {
        pid = record.launch.pid;
        expect(process.emit("SIGTERM", "SIGTERM")).toBe(true);
      }
      return write(record);
    });
    try {
      const exit = await runSession(session.id, [process.execPath, "-e", "setInterval(()=>{},1000)"], { store: fixture.store, stdio: "ignore" });
      expect(exit.signal).toBe("SIGTERM");
    } finally { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} } }
  });
  it("blocks release and GC while a launched command is active", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const running = runSession(a.id, [process.execPath, "-e", "setTimeout(()=>{},30000)"], { store: fixture.store, stdio: "ignore" });
    let pid: number | null = null;
    try {
      await vi.waitFor(async () => { pid = (await findSession(a.id, fixture.store)).launch?.pid ?? null; expect(pid).not.toBeNull(); });
      await expect(releaseSession(a.id, { store: fixture.store })).rejects.toThrow(/active/);
      expect((await gcSessions({ store: fixture.store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("retained");
    } finally { if (pid) process.kill(-pid, "SIGTERM"); await running; }
  });
  it("forwards SIGTERM through the CLI and preserves signal termination", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const marker = path.join(a.root, "started");
    const child = execa(process.execPath, ["--import", "tsx", path.resolve("src/index.ts"), "session", "run", a.id, "--store", fixture.store, "--", process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},1000)`], { reject: false });
    try {
      await vi.waitFor(async () => { expect(await fs.readFile(marker, "utf8")).toBe("yes"); }, { timeout: 8000 });
      child.kill("SIGTERM");
      expect((await child).signal).toBe("SIGTERM");
      expect((await findSession(a.id, fixture.store)).lastExit?.signal).toBe("SIGTERM");
    } finally {
      // Clean up a detached fixture child even if its supervisor died early.
      const record = await findSession(a.id, fixture.store);
      if (record.launch?.pid) { try { process.kill(-record.launch.pid, "SIGKILL"); } catch {} }
      child.kill("SIGKILL"); await child;
    }
  }, 15_000);
});
