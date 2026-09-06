import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { createSession, gcSessions, inspectSession, releaseSession, claimSession } from "../core/sessions";
import { findSession, writeSession } from "../core/sessionStore";
import { probeCow, requireGit, sessionGit } from "../core/sessionStorage";
import { runSession } from "../core/sessionRun";
import { inspectCommand } from "../commands/inspect";
import { loadOrCreateKey } from "../core/secrets";
import { writeEnvScope } from "../core/env";
import { mapPaths } from "../core/map";
import { loadWorkspaceDefinition } from "../core/discovery";

let root: string;
let source: string;
let store: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.BOOT_TEST_WORKSPACE_ROOT ?? os.tmpdir(), "boot-sessions-")));
  source = path.join(root, "source"); store = path.join(root, "store");
  vi.stubEnv("BOOT_HOME", path.join(root, "home"));
  await fs.mkdir(source);
  await requireGit(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "file.txt"), "original\n");
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n.boot/\n");
  await fs.writeFile(path.join(source, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "sessions", name: "Sessions" }, repositories: { app: { path: "." } }, profiles: { agent: { repositories: "all" } } }));
  await requireGit(source, ["add", "."]);
  await commit(source, "base");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function commit(directory: string, message: string) {
  await requireGit(directory, ["-c", "user.name=Session Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", message]);
}

describe("managed sessions on real filesystems", () => {
  it("freezes grouped profile scope and delivers selected encrypted values only at launch", async () => {
    const workspace = path.join(root, "group"); await fs.mkdir(workspace);
    await fs.rename(source, path.join(workspace, "app"));
    await requireGit(workspace, ["clone", "--no-local", "app", "lib"]);
    const definition = { schemaVersion: 1, workspace: { id: "group", name: "Group" }, repositories: { app: { path: "app" }, lib: { path: "lib" }, excluded: { path: "excluded" } }, env: { required: [{ name: "BOOT_TEST_SELECTED_VALUE", source: "boot" }, { name: "BOOT_TEST_UNSELECTED_VALUE", source: "boot" }] }, profiles: { agent: { repositories: ["app", "lib"], env: ["BOOT_TEST_SELECTED_VALUE"] } } };
    await fs.writeFile(path.join(workspace, "boot.yaml"), stringify(definition));
    const { key } = await loadOrCreateKey();
    await fs.mkdir(mapPaths(workspace).mapDir, { recursive: true });
    const synthetic = "synthetic-session-fixture-value";
    await writeEnvScope(mapPaths(workspace).mapDir, { type: "global" }, { BOOT_TEST_SELECTED_VALUE: synthetic, BOOT_TEST_UNSELECTED_VALUE: "synthetic-unselected" }, key);
    vi.stubEnv("BOOT_TEST_SELECTED_VALUE", undefined); vi.stubEnv("BOOT_TEST_UNSELECTED_VALUE", undefined);
    const session = await createSession(workspace, { store, storage: "clone" });
    expect(session.repositories.map((repo) => repo.id)).toEqual(["app", "lib"]);
    definition.profiles.agent.repositories.push("excluded");
    await fs.writeFile(path.join(workspace, "boot.yaml"), stringify(definition));
    expect(Object.keys((await loadWorkspaceDefinition(session.root)).repositories!)).toEqual(["app", "lib"]);
    const exit = await runSession(session.id, [process.execPath, "-e", `process.exit(process.env.BOOT_TEST_SELECTED_VALUE === ${JSON.stringify(synthetic)} && process.env.BOOT_TEST_UNSELECTED_VALUE === undefined ? 0 : 1)`], { store, stdio: "ignore" });
    expect(exit.code).toBe(0);
    expect(JSON.stringify(await inspectSession(session.id, store))).not.toContain(synthetic);
    expect(await fs.readdir(path.join(session.root, ".boot"))).not.toContain("map");
    await expect(fs.lstat(path.join(session.root, ".env"))).rejects.toThrow(/ENOENT/);
  }, 15_000);
  it("rejects escaping tracked symlinks introduced by working-tree patches", async () => {
    await fs.writeFile(path.join(source, "link-target"), "safe\n");
    await fs.symlink("link-target", path.join(source, "link"));
    await requireGit(source, ["add", "."]); await commit(source, "relative link");
    await fs.rm(path.join(source, "link")); await fs.symlink(root, path.join(source, "link"));
    await expect(createSession(source, { store, storage: "clone", includeWorkingTree: true })).rejects.toThrow(/cannot be relocated independently/);
  });
  it("reflinks independent files, indexes, commits, and prepared dependencies", async (context) => {
    const capability = await probeCow(root, root);
    console.info("Native CoW capability:", capability);
    if (!capability.backend) {
      if (process.env.BOOT_TEST_REQUIRE_COW === "1") throw new Error(`Real CoW test unavailable: ${capability.reason}`);
      context.skip(capability.reason!);
      return;
    }
    await fs.mkdir(path.join(source, "node_modules", "fixture"), { recursive: true });
    await fs.writeFile(path.join(source, "node_modules", "fixture", "index.js"), "module.exports = 1;\n");
    const a = await createSession(source, { name: "a", store, storage: "cow", include: ["node_modules"] });
    const b = await createSession(source, { name: "b", store, storage: "cow", include: ["node_modules"] });
    expect(a.repositories[0]!.backend).toBe(capability.backend);
    await fs.writeFile(path.join(a.root, "file.txt"), "agent a\n");
    await requireGit(a.root, ["add", "file.txt"]);
    expect(await requireGit(b.root, ["diff", "--cached", "--name-only"])).toBe("");
    await commit(a.root, "agent a");
    await fs.writeFile(path.join(b.root, "file.txt"), "agent b\n");
    await requireGit(b.root, ["add", "file.txt"]); await commit(b.root, "agent b");
    await fs.writeFile(path.join(a.root, "node_modules", "fixture", "index.js"), "module.exports = 2;\n");
    expect(await fs.readFile(path.join(b.root, "node_modules", "fixture", "index.js"), "utf8")).toContain("= 1");
    expect(await fs.readFile(path.join(source, "file.txt"), "utf8")).toBe("original\n");
    expect((await inspectSession(a.id, store)).repositories[0]!.outstandingCommits).toHaveLength(1);
  }, 20_000);
  it("uses a Boot-owned shared object store for independent worktrees", async () => {
    const [a, b] = await Promise.all([
      createSession(source, { name: "a", store, storage: "worktree" }),
      createSession(source, { name: "b", store, storage: "worktree" }),
    ]);
    expect(await requireGit(a.root, ["rev-parse", "--git-common-dir"])).toBe(await requireGit(b.root, ["rev-parse", "--git-common-dir"]));
    expect(await requireGit(a.root, ["rev-parse", "--git-dir"])).not.toBe(await requireGit(b.root, ["rev-parse", "--git-dir"]));
    expect(await requireGit(source, ["worktree", "list", "--porcelain"])).not.toContain(a.root);
    await fs.writeFile(path.join(a.root, "file.txt"), "a\n"); await requireGit(a.root, ["add", "."]); await commit(a.root, "a");
    expect(await fs.readFile(path.join(b.root, "file.txt"), "utf8")).toBe("original\n");
    expect(await requireGit(b.root, ["diff", "--cached", "--name-only"])).toBe("");
  });
  it("snapshots linked-worktree sources without copying their .git pointer", async () => {
    const linked = path.join(root, "linked");
    await requireGit(source, ["worktree", "add", "-b", "linked", linked]);
    const a = await createSession(linked, { store, storage: "clone" });
    expect((await fs.lstat(path.join(a.root, ".git"))).isDirectory()).toBe(true);
    await fs.writeFile(path.join(a.root, "file.txt"), "changed\n"); await requireGit(a.root, ["add", "."]);
    expect(await requireGit(linked, ["diff", "--cached", "--name-only"])).toBe("");
  });
  it("preserves staged and unstaged state and protects imported work after reset", async () => {
    await fs.writeFile(path.join(source, "file.txt"), "staged\n"); await requireGit(source, ["add", "file.txt"]);
    await fs.writeFile(path.join(source, "file.txt"), "unstaged\n"); await fs.writeFile(path.join(source, "notes.txt"), "notes");
    const excluded = await createSession(source, { name: "excluded", store, storage: "clone" });
    expect(await fs.readFile(path.join(excluded.root, "file.txt"), "utf8")).toBe("original\n");
    expect(excluded.repositories[0]!.excludedChanges).toContain("notes.txt");
    const captured = await createSession(source, { name: "captured", store, storage: "clone", includeWorkingTree: true });
    expect(await requireGit(captured.root, ["show", ":file.txt"])).toBe("staged");
    expect(await fs.readFile(path.join(captured.root, "file.txt"), "utf8")).toBe("unstaged\n");
    await requireGit(captured.root, ["reset", "--hard", "HEAD"]); await fs.rm(path.join(captured.root, "notes.txt"));
    await releaseSession(captured.id, { store });
    expect((await inspectSession(captured.id, store)).protection.join(" ")).toContain("captured at creation");
  });
  it("previews without writes, protects outstanding work, and reclaims released sessions", async () => {
    const a = await createSession(source, { store, storage: "worktree" });
    await releaseSession(a.id, { store });
    const before = await fs.readFile(path.join(store, "sessions", a.id, "session.json"), "utf8");
    expect((await gcSessions({ store })).sessions[0]!.action).toBe("would-remove");
    expect(await fs.readFile(path.join(store, "sessions", a.id, "session.json"), "utf8")).toBe(before);
    await fs.writeFile(path.join(a.root, "notes"), "keep");
    expect((await gcSessions({ store, apply: true })).sessions[0]!.action).toBe("retained");
    await fs.rm(path.join(a.root, "notes"));
    expect((await gcSessions({ store, apply: true })).sessions[0]!.action).toBe("removed");
    expect(await fs.readdir(path.join(store, "seeds"))).toEqual([]);
  });
  it("launches with exact argv, cwd, session identity, and exit code", async () => {
    const a = await createSession(source, { store, storage: "clone" });
    const result = await runSession(a.id, [process.execPath, "-e", "require('fs').writeFileSync('argv.json', JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),id:process.env.BOOT_SESSION_ID}));process.exit(7)", "one two", "$(untouched)", "--flag"], { store, stdio: "ignore" });
    expect(result.code).toBe(7);
    const output = JSON.parse(await fs.readFile(path.join(a.root, "argv.json"), "utf8"));
    expect(output).toEqual({ args: ["one two", "$(untouched)", "--flag"], cwd: a.root, id: a.id });
    const logs: string[] = []; vi.spyOn(console, "log").mockImplementation((value) => { logs.push(value); });
    await inspectCommand(a.root, { json: true });
    expect(JSON.parse(logs.join("\n")).session.id).toBe(a.id);
  });
  it("protects external claims and requires the owner to release them", async () => {
    const a = await createSession(source, { store, storage: "clone" });
    await claimSession(a.id, "external-demo", store);
    expect((await gcSessions({ store, apply: true })).sessions[0]!.action).toBe("retained");
    await expect(releaseSession(a.id, { store })).rejects.toThrow(/external/);
    await releaseSession(a.id, { store, owner: "external-demo" });
  });
  it("refuses symlink replacement even with a scoped destructive override", async () => {
    const a = await createSession(source, { store, storage: "clone" });
    await releaseSession(a.id, { store });
    await fs.rename(a.root, `${a.root}-original`); await fs.symlink(source, a.root, "dir");
    await expect(gcSessions({ store, apply: true, session: a.id, discardWork: a.id })).rejects.toThrow(/symlink/);
    expect(await fs.readFile(path.join(source, "file.txt"), "utf8")).toBe("original\n");
  });
  it("retains incomplete provisioning containing files unless explicitly discarded", async () => {
    const a = await createSession(source, { store, storage: "clone" });
    const record = await findSession(a.id, store); record.state = "provisioning"; await writeSession(record);
    expect((await gcSessions({ store, apply: true })).sessions[0]!.action).toBe("retained");
    expect((await gcSessions({ store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("removed");
  });
});
