import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { randomBytes } from "node:crypto";
import { createSession, inspectSession, releaseSession, gcSessions, processExists } from "../core/sessions";
import { runSession } from "../core/sessionRun";
import * as store from "../core/sessionStore";
import { probeCow, requireGit } from "../core/sessionStorage";
import { windowsCloneFiles, windowsUserSid } from "../core/sessionWindows";
import { resolveWithinRoot } from "../core/pathUtils";
import { sessionFixture } from "./sessionFixture";

// These repositories are generated test data with no remotes or credentials.
// Preserve diagnostics for their failed Git commands without changing CLI output.
vi.mock("execa", async (original) => {
  const actual = await original<typeof import("execa")>();
  return { ...actual, execa: new Proxy(actual.execa, { apply(target, receiver, args) {
    const child = Reflect.apply(target, receiver, args);
    if (args[0] === "git" && Array.isArray(args[1]) && args[1].some((value: unknown) => typeof value === "string" && value.includes("boot-session-case-"))) {
      void child.then((result: { exitCode: number; stderr: string }) => { if (result.exitCode !== 0) console.error("Fixture Git failure:", result.stderr); }, () => {});
    }
    return child;
  } }) };
});

const windows = process.platform === "win32" ? describe : describe.skip;
windows("Windows native sessions", () => {
  let fixture: Awaited<ReturnType<typeof sessionFixture>>;
  const cow = process.env.BOOT_TEST_WINDOWS_EXPECT_COW === "1";
  beforeEach(async () => { fixture = await sessionFixture(); vi.stubEnv("BOOT_HOME", fixture.home); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }, 30_000);
  const command = (args: string[]) => execa(process.execPath, ["--import", "tsx", path.resolve("src/index.ts"), ...args], { reject: false });
  it("probes actual ReFS cloning or refuses NTFS, including partial clusters, empty files and Unicode", async () => {
    expect((await probeCow(fixture.root, fixture.root)).backend).toBe(cow ? "refs-clone" : null);
    const original = path.join(fixture.root, "source 雪 with spaces"), cloned = path.join(fixture.root, "clone 雪 with spaces");
    await fs.writeFile(original, randomBytes(128 * 1024 + 13));
    if (!cow) { await expect(windowsCloneFiles([{ source: original, destination: cloned }])).rejects.toThrow(/ReFS/); await expect(fs.stat(cloned)).rejects.toThrow(/ENOENT/); return; }
    await windowsCloneFiles([{ source: original, destination: cloned }]);
    expect((await fs.readFile(original)).equals(await fs.readFile(cloned))).toBe(true);
    await fs.writeFile(cloned, "session edit"); expect((await fs.stat(original)).size).toBe(128 * 1024 + 13);
    await fs.writeFile(original, "source edit"); expect(await fs.readFile(cloned, "utf8")).toBe("session edit");
    await expect(windowsCloneFiles([{ source: original, destination: cloned }])).rejects.toThrow();
    expect(await fs.readFile(cloned, "utf8")).toBe("session edit");
    await fs.writeFile(original, ""); await fs.rm(cloned); await windowsCloneFiles([{ source: original, destination: cloned }]);
    expect((await fs.stat(cloned)).size).toBe(0);
    const deep = path.join(fixture.root, ...Array.from({ length: 12 }, () => "long-path-segment-with-spaces"));
    await fs.mkdir(deep, { recursive: true }); await fs.writeFile(path.join(deep, "source"), "long path");
    await windowsCloneFiles([{ source: path.join(deep, "source"), destination: path.join(deep, "cloned") }]);
    expect(await fs.readFile(path.join(deep, "cloned"), "utf8")).toBe("long path");
    // Refuse silently dropping additional Windows streams.
    await fs.writeFile(`${original}:notes`, "keep this stream"); await fs.rm(cloned);
    await expect(windowsCloneFiles([{ source: original, destination: cloned }])).rejects.toThrow();
  }, 60_000);
  it("creates independent worktree/clone sessions and uses forced CoW only on ReFS", async () => {
    for (const storage of ["worktree", "clone", "auto", "cow"] as const) {
      if (storage === "cow" && !cow) { await expect(createSession(fixture.source, { store: fixture.store, storage, name: storage })).rejects.toThrow(/CoW/); continue; }
      const a = await createSession(fixture.source, { store: fixture.store, storage, name: storage });
      expect(a.owner.sid).toBe(windowsUserSid());
      expect(a.repositories[0]!.backend).toBe(storage === "cow" || (storage === "auto" && cow) ? "refs-clone" : storage === "auto" ? "worktree" : storage);
      await fs.writeFile(path.join(a.root, "file.txt"), "edited\n"); await requireGit(a.root, ["add", "file.txt"]);
      expect(await requireGit(fixture.source, ["diff", "--cached", "--name-only"])).toBe("");
      expect(await fs.readFile(path.join(fixture.source, "file.txt"), "utf8")).toBe("original\n");
      await releaseSession(a.id, { store: a.store });
      expect((await gcSessions({ store: a.store, apply: true, session: a.id })).sessions[0]!.action).toBe("retained");
      expect((await gcSessions({ store: a.store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("removed");
    }
  }, 120_000);
  it("preserves cwd, Unicode, empty/metacharacter arguments and exit codes through a Node npm shim", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const bin = path.join(fixture.root, "shim bin"); await fs.mkdir(bin);
    const entry = path.join(bin, "agent.cjs"), shim = path.join(bin, "agent.cmd");
    const args = ["", "two words", "雪", "quote\"end", "trail\\", "%PATH%", "a&b|c^d", "$(literal)"];
    const result = path.join(fixture.root, "launch-result.json");
    await fs.writeFile(entry, `require('fs').writeFileSync(${JSON.stringify(result)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),id:process.env.BOOT_SESSION_ID}));process.exit(23)`);
    await fs.writeFile(shim, '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\agent.cjs" %*\r\n');
    const exit = await runSession(a.id, [shim, ...args], { store: a.store, stdio: "ignore" });
    expect(exit).toEqual({ code: 23, signal: null });
    const output = JSON.parse(await fs.readFile(result, "utf8"));
    expect(output).toEqual({ argv: args, cwd: a.root, id: a.id });
    expect((await store.findSession(a.id, a.store)).state).toBe("ready");
  }, 60_000);
  it("keeps a detached descendant protected after its parent exits and stops it on cancellation", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const marker = path.join(fixture.root, "descendant.json");
    const childCode = `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
    const parentCode = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});child.unref();process.exit(7)`;
    const running = runSession(a.id, [process.execPath, "-e", parentCode], { store: a.store, stdio: "ignore" });
    let pid = 0;
    try {
      await vi.waitFor(async () => { pid = Number(await fs.readFile(marker, "utf8")); expect(pid).toBeGreaterThan(0); }, { timeout: 30_000 });
      await expect(releaseSession(a.id, { store: a.store })).rejects.toThrow(/active/);
      expect((await gcSessions({ store: a.store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("retained");
      expect(process.emit("SIGINT", "SIGINT")).toBe(true);
      expect((await running).signal).toBe("SIGINT");
      await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 10_000 });
      await releaseSession(a.id, { store: a.store });
    } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
  }, 60_000);
  it("handles cancellation before the helper PID is journaled without leaving children", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const write = store.writeSession; let sent = false;
    vi.spyOn(store, "writeSession").mockImplementation(async (record) => {
      if (record.launch?.pid && !sent) { sent = true; expect(process.emit("SIGTERM", "SIGTERM")).toBe(true); }
      return write(record);
    });
    expect((await runSession(a.id, [process.execPath, "-e", "setInterval(()=>{},1000)"], { store: a.store, stdio: "ignore" })).signal).toBe("SIGTERM");
    expect((await store.findSession(a.id, a.store)).launch?.finished).toBe(true);
  }, 60_000);
  it("kills the job after an actually terminated CLI supervisor and requires acknowledged recovery", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    const marker = path.join(fixture.root, "started.json");
    const cli = command(["session", "run", a.id, "--store", a.store, "--", process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`]);
    try {
      let pid = 0;
      await vi.waitFor(async () => { pid = Number(await fs.readFile(marker, "utf8")); expect(pid).toBeGreaterThan(0); }, { timeout: 30_000 });
      cli.kill("SIGKILL"); await cli;
      await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 10_000 });
      await expect(releaseSession(a.id, { store: a.store })).rejects.toThrow(/acknowledge-stopped/);
      await releaseSession(a.id, { store: a.store, acknowledgeStopped: true });
      expect((await gcSessions({ store: a.store, apply: true })).sessions[0]!.action).toBe("removed");
    } finally { cli.kill("SIGKILL"); await cli; }
  }, 60_000);
  it("refuses junction replacement, named streams, device paths, and a changed owner SID", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    for (const name of ["file:stream", "NUL", "dir/COM1.txt", "name.", "name "]) expect(() => resolveWithinRoot(a.root, name)).toThrow(/Windows/);
    await releaseSession(a.id, { store: a.store });
    const record = JSON.parse(await fs.readFile(store.recordPath(a.store, a.id), "utf8"));
    record.owner.sid = "S-1-5-21-1-2-3-4";
    await fs.writeFile(store.recordPath(a.store, a.id), JSON.stringify(record));
    await expect(gcSessions({ store: a.store, apply: true, session: a.id, discardWork: a.id })).rejects.toThrow(/ownership/);
    await fs.writeFile(store.recordPath(a.store, a.id), JSON.stringify({ ...record, owner: a.owner }));
    await fs.rename(a.root, `${a.root}-saved`); await fs.symlink(fixture.source, a.root, "junction");
    await expect(gcSessions({ store: a.store, apply: true, session: a.id, discardWork: a.id })).rejects.toThrow(/symlink/);
    await fs.unlink(a.root); await fs.rename(`${a.root}-saved`, a.root);
  }, 60_000);
  it("runs the standalone Windows distribution with the same native launcher", async (context) => {
    const binary = process.env.BOOT_TEST_WINDOWS_BINARY;
    if (!binary) { context.skip("standalone binary supplied by CI"); return; }
    const a = await createSession(fixture.source, { store: fixture.store, storage: cow ? "cow" : "worktree" });
    const result = await execa(binary, ["session", "run", a.id, "--store", a.store, "--", process.execPath, "-e", "process.exit(41)"], { reject: false, timeout: 25_000 });
    if (result.timedOut) console.error("Standalone timeout state:", (await store.findSession(a.id, a.store)).launch);
    expect(result.exitCode).toBe(41);
    expect((await inspectSession(a.id, a.store)).session.lastExit?.code).toBe(41);
  }, 60_000);
});
