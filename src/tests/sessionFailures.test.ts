import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { sessionFixture } from "./sessionFixture";
import { createSession, gcSessions, releaseSession, inspectSession } from "../core/sessions";
import { listSessionRecords } from "../core/sessionStore";
import * as native from "../core/sessionNative";
import { constants } from "node:fs";
import { requireGit } from "../core/sessionStorage";
import { stringify } from "yaml";

let fixture: Awaited<ReturnType<typeof sessionFixture>>;
beforeEach(async () => { fixture = await sessionFixture(); vi.stubEnv("BOOT_HOME", fixture.home); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.root, { recursive: true, force: true }); });

describe("session fallbacks and recovery", () => {
  it("retains staged work even when the working file has been restored to HEAD", async () => {
    const session = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    await fs.writeFile(path.join(session.root, "file.txt"), "only in the index\n");
    await requireGit(session.root, ["add", "file.txt"]);
    await fs.writeFile(path.join(session.root, "file.txt"), "original\n");
    await releaseSession(session.id, { store: fixture.store });
    expect((await inspectSession(session.id, fixture.store)).repositories[0]!.trackedChanges).toContain("file.txt");
    expect((await gcSessions({ store: fixture.store, apply: true })).sessions[0]!.action).toBe("retained");
  });
  it("protects files alongside repositories in a grouped workspace", async () => {
    const workspace = path.join(fixture.root, "group"); await fs.mkdir(workspace);
    await fs.rename(fixture.source, path.join(workspace, "app"));
    await fs.writeFile(path.join(workspace, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "group", name: "Group" }, repositories: { app: { path: "app" } } }));
    const session = await createSession(workspace, { store: fixture.store, storage: "clone" });
    await releaseSession(session.id, { store: fixture.store });
    expect((await inspectSession(session.id, fixture.store)).eligible).toBe(true);
    await fs.writeFile(path.join(session.root, "task-notes.md"), "Keep this work.");
    expect((await inspectSession(session.id, fixture.store)).workspaceChanges).toContain("task-notes.md");
    expect((await gcSessions({ store: fixture.store, apply: true })).sessions[0]!.action).toBe("retained");
  });
  it("keeps a deletion journal until its seed is reclaimed and can retry removal", async () => {
    const session = await createSession(fixture.source, { store: fixture.store, storage: "worktree" });
    await releaseSession(session.id, { store: fixture.store });
    const remove = fs.rm.bind(fs);
    const failure = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === path.dirname(session.root)) throw new Error("simulated interrupted final removal");
      return remove(target, options);
    });
    await expect(gcSessions({ store: fixture.store, apply: true })).rejects.toThrow(/interrupted final/);
    failure.mockRestore();
    expect((await listSessionRecords(fixture.store))[0]!.state).toBe("deleting");
    expect(await fs.readdir(path.join(fixture.store, "seeds"))).toEqual([]);
    expect((await gcSessions({ store: fixture.store, apply: true })).sessions[0]!.action).toBe("removed");
  });
  it("never silently copies for explicit CoW and reports auto's fallback", async () => {
    if (process.platform === "darwin") vi.spyOn(native, "macCloneFiles").mockRejectedValue(Object.assign(new Error("unsupported test filesystem"), { code: "ENOTSUP" }));
    else {
      const original = fs.copyFile.bind(fs);
      vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, flags) => {
        if (flags && (flags & constants.COPYFILE_FICLONE_FORCE)) throw Object.assign(new Error("unsupported test filesystem"), { code: "ENOTSUP" });
        return original(from, to, flags);
      });
    }
    await expect(createSession(fixture.source, { name: "forced", store: fixture.store, storage: "cow" })).rejects.toThrow(/CoW failed.*ENOTSUP/);
    const automatic = await createSession(fixture.source, { name: "auto", store: fixture.store, storage: "auto" });
    expect(automatic.repositories[0]!.backend).toBe("worktree");
    expect(automatic.repositories[0]!.fallbackReason).toContain("ENOTSUP");
    await fs.mkdir(path.join(fixture.source, "node_modules"));
    await expect(createSession(fixture.source, { name: "artifacts", store: fixture.store, storage: "auto", include: ["node_modules"] })).rejects.toThrow(/artifacts require CoW/);
  });
  it("validates real unsupported Linux tmpfs without a mock", async (context) => {
    if (process.platform !== "linux") { context.skip("Linux tmpfs fixture"); return; }
    const temporary = await fs.mkdtemp("/dev/shm/boot-session-no-cow-");
    try {
      const automatic = await createSession(fixture.source, { name: "tmpfs", store: temporary, storage: "auto" });
      expect(automatic.repositories[0]!.backend).toBe("worktree");
      expect(automatic.repositories[0]!.fallbackReason).toMatch(/CoW failed/);
      await expect(createSession(fixture.source, { name: "forced-tmpfs", store: temporary, storage: "cow" })).rejects.toThrow(/CoW failed/);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
  it("serializes competing CLI processes without sharing indexes", async () => {
    const script = path.resolve("src/index.ts");
    const args = ["--import", "tsx", script, "session", "create", fixture.source, "--store", fixture.store, "--storage", "worktree", "--json"];
    const [a, b] = await Promise.all([execa(process.execPath, [...args, "--name", "first"]), execa(process.execPath, [...args, "--name", "second"])]);
    const first = JSON.parse(a.stdout), second = JSON.parse(b.stdout);
    expect(first.id).not.toBe(second.id);
    expect(await requireGit(first.root, ["rev-parse", "--git-dir"])).not.toBe(await requireGit(second.root, ["rev-parse", "--git-dir"]));
  }, 20_000);
  it("recovers an actually killed provisioning process using only its owned resources", async () => {
    const bin = path.join(fixture.root, "bin"); await fs.mkdir(bin);
    const marker = path.join(fixture.root, "clone-started");
    const wrapper = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');if(process.argv.includes('clone')){fs.writeFileSync(${JSON.stringify(marker)},'yes');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}const r=cp.spawnSync('/usr/bin/git',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`;
    await fs.writeFile(path.join(bin, "git"), wrapper, { mode: 0o700 });
    const child = execa(process.execPath, ["--import", "tsx", path.resolve("src/index.ts"), "session", "create", fixture.source, "--store", fixture.store, "--storage", "clone", "--name", "interrupted"], { detached: true, reject: false, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    try {
      await vi.waitFor(async () => { expect(await fs.readFile(marker, "utf8")).toBe("yes"); }, { timeout: 8000 });
      process.kill(-child.pid!, "SIGKILL"); await child;
      const [record] = await listSessionRecords(fixture.store);
      expect(record!.state).toBe("provisioning");
      const preview = await gcSessions({ store: fixture.store });
      expect(preview.sessions[0]!.action).toBe("would-remove");
      await gcSessions({ store: fixture.store, apply: true });
      expect(await listSessionRecords(fixture.store)).toEqual([]);
      expect(await fs.readFile(path.join(fixture.source, "file.txt"), "utf8")).toBe("original\n");
    } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch {} await child; }
  }, 20_000);
  it("protects stash commits and work when the source becomes unavailable", async () => {
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    await fs.writeFile(path.join(a.root, "file.txt"), "stashed\n");
    await requireGit(a.root, ["stash", "push", "-m", "keep"]);
    await releaseSession(a.id, { store: fixture.store });
    expect((await inspectSession(a.id, fixture.store)).repositories[0]!.outstandingCommits.length).toBeGreaterThan(0);
    await fs.rename(fixture.source, `${fixture.source}-moved`);
    expect((await gcSessions({ store: fixture.store, apply: true })).sessions[0]!.action).toBe("retained");
  });
});
