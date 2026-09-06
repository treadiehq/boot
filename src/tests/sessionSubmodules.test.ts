import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { sessionFixture } from "./sessionFixture";
import { createSession, inspectSession, releaseSession, gcSessions } from "../core/sessions";
import { probeCow, requireGit } from "../core/sessionStorage";

let fixture: Awaited<ReturnType<typeof sessionFixture>>;
const commit = (dir: string) => requireGit(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-am", "fixture"]);
beforeEach(async () => { fixture = await sessionFixture(); vi.stubEnv("BOOT_HOME", fixture.home); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.root, { recursive: true, force: true }); });
async function submodule(recursive = false) {
  const library = path.join(fixture.root, "library");
  await requireGit(fixture.root, ["clone", "--no-local", fixture.source, library]);
  if (recursive) {
    await requireGit(library, ["-c", "protocol.file.allow=always", "submodule", "add", fixture.source, "inner"]);
    await commit(library);
  }
  await requireGit(fixture.source, ["-c", "protocol.file.allow=always", "submodule", "add", library, "plugins/lib"]);
  await commit(fixture.source);
  if (recursive) await requireGit(fixture.source, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  return path.join(fixture.source, "plugins/lib");
}
describe("independent submodule snapshots", () => {
  for (const storage of ["clone", "worktree", "cow"] as const) it(`recursively isolates submodules and removes owned registrations with ${storage}`, async (context) => {
    if (storage === "cow" && !(await probeCow(fixture.root, fixture.root)).backend) { context.skip(); return; }
    const child = await submodule(true);
    const pinned = await requireGit(child, ["rev-parse", "HEAD"]);
    const a = await createSession(fixture.source, { store: fixture.store, storage, name: "a" });
    const b = await createSession(fixture.source, { store: fixture.store, storage, name: "b" });
    expect(a.repositories).toHaveLength(3);
    expect(await requireGit(path.join(a.root, "plugins/lib"), ["rev-parse", "HEAD"])).toBe(pinned);
    await fs.writeFile(path.join(a.root, "plugins/lib/inner/file.txt"), "agent a\n");
    await requireGit(path.join(a.root, "plugins/lib/inner"), ["add", "file.txt"]);
    expect(await requireGit(path.join(b.root, "plugins/lib/inner"), ["diff", "--cached", "--name-only"])).toBe("");
    expect(await fs.readFile(path.join(child, "inner/file.txt"), "utf8")).toBe("original\n");
    await releaseSession(a.id, { store: fixture.store });
    await releaseSession(b.id, { store: fixture.store });
    expect((await inspectSession(a.id, fixture.store)).eligible).toBe(false);
    const clean = await inspectSession(b.id, fixture.store);
    expect(clean.protection).toEqual([]);
    expect((await gcSessions({ store: fixture.store, apply: true, session: b.id })).sessions[0]!.action).toBe("removed");
    expect((await gcSessions({ store: fixture.store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("removed");
    expect(await fs.readdir(path.join(fixture.store, "seeds"))).toEqual([]);
    expect(await requireGit(fixture.source, ["status", "--porcelain"])).toBe("");
  }, process.platform === "win32" ? 60_000 : 30_000);
  it("uses pinned commits by default and captures child HEAD, parent index, and child staged/unstaged state explicitly", async () => {
    const child = await submodule();
    const base = await requireGit(child, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(child, "file.txt"), "child commit\n"); await commit(child);
    const indexed = await requireGit(child, ["rev-parse", "HEAD"]);
    await requireGit(fixture.source, ["add", "plugins/lib"]);
    await fs.writeFile(path.join(child, "file.txt"), "second commit\n"); await commit(child);
    const head = await requireGit(child, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(child, "file.txt"), "staged\n"); await requireGit(child, ["add", "file.txt"]);
    await fs.writeFile(path.join(child, "file.txt"), "unstaged\n");
    await fs.writeFile(path.join(child, "notes.txt"), "notes");
    const clean = await createSession(fixture.source, { store: fixture.store, storage: "clone", name: "clean" });
    expect(await requireGit(path.join(clean.root, "plugins/lib"), ["rev-parse", "HEAD"])).toBe(base);
    const dirty = await createSession(fixture.source, { store: fixture.store, storage: "clone", name: "dirty", includeWorkingTree: true });
    expect(await requireGit(path.join(dirty.root, "plugins/lib"), ["rev-parse", "HEAD"])).toBe(head);
    expect(await requireGit(dirty.root, ["ls-files", "--stage", "plugins/lib"])).toContain(indexed);
    expect(await requireGit(path.join(dirty.root, "plugins/lib"), ["show", ":file.txt"])).toBe("staged");
    expect(await fs.readFile(path.join(dirty.root, "plugins/lib/file.txt"), "utf8")).toBe("unstaged\n");
    expect(await fs.readFile(path.join(dirty.root, "plugins/lib/notes.txt"), "utf8")).toBe("notes");
    await releaseSession(dirty.id, { store: fixture.store });
    expect((await inspectSession(dirty.id, fixture.store)).eligible).toBe(false);
  }, 30_000);
  it("requires initialized sources and committed topology changes", async () => {
    await submodule();
    await requireGit(fixture.source, ["submodule", "deinit", "--force", "plugins/lib"]);
    await expect(createSession(fixture.source, { store: fixture.store, storage: "clone", name: "uninitialized" })).rejects.toThrow(/Initialize source submodule/);
    await requireGit(fixture.source, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    await requireGit(fixture.source, ["rm", "--cached", "plugins/lib"]);
    await expect(createSession(fixture.source, { store: fixture.store, storage: "clone", name: "topology", includeWorkingTree: true })).rejects.toThrow(/Commit submodule additions/);
  });
  it("assigns prepared artifacts to the deepest submodule and refuses whole-repository includes", async (context) => {
    if (!(await probeCow(fixture.root, fixture.root)).backend) { context.skip(); return; }
    const child = await submodule();
    await fs.mkdir(path.join(child, "node_modules")); await fs.writeFile(path.join(child, "node_modules/fixture.js"), "prepared");
    const session = await createSession(fixture.source, { store: fixture.store, storage: "cow", include: ["plugins/lib/node_modules"] });
    expect(session.repositories[1]!.includes[0]!.path).toBe("node_modules");
    expect(await fs.readFile(path.join(session.root, "plugins/lib/node_modules/fixture.js"), "utf8")).toBe("prepared");
    await expect(createSession(fixture.source, { store: fixture.store, storage: "cow", include: ["plugins/lib"] })).rejects.toThrow(/not entire submodules/);
  });
});
