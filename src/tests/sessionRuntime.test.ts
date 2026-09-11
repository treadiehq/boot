import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parse, stringify } from "yaml";
import { execa } from "execa";
import { sessionFixture } from "./sessionFixture";
import { createSession, inspectSession, releaseSession, gcSessions } from "../core/sessions";
import { runSession } from "../core/sessionRun";
import { workspaceDefinitionSchema, resolveWorkspace } from "../core/workspace";
import { requireGit } from "../core/sessionStorage";

let fixture: Awaited<ReturnType<typeof sessionFixture>>;
beforeEach(async () => { fixture = await sessionFixture(); vi.stubEnv("BOOT_HOME", fixture.home); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.root, { recursive: true, force: true }); });
async function defineRuntime() {
  const definition = parse(await fs.readFile(path.join(fixture.source, "boot.yaml"), "utf8"));
  definition.runtime = { web: { type: "port", env: "PORT" }, api: { type: "port", env: "API_PORT" }, postgres: { type: "postgres", env: "DATABASE_URL" } };
  definition.profiles.agent.runtime = ["web", "api"];
  await fs.writeFile(path.join(fixture.source, "boot.yaml"), stringify(definition));
  await requireGit(fixture.source, ["add", "boot.yaml"]);
  await requireGit(fixture.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "runtime"]);
  return definition;
}
describe("opt-in session runtime", () => {
  it("validates selection, environment collisions, reserved variables and PostgreSQL versions", async () => {
    const definition = await defineRuntime();
    expect(Object.keys(resolveWorkspace(workspaceDefinitionSchema.parse(definition), "agent").runtime!)).toEqual(["web", "api"]);
    expect(workspaceDefinitionSchema.safeParse({ ...definition, runtime: { x: { type: "port", env: "PATH" } } }).success).toBe(false);
    expect(workspaceDefinitionSchema.safeParse({ ...definition, runtime: { ...definition.runtime, api: { type: "port", env: "PORT" } } }).success).toBe(false);
    expect(workspaceDefinitionSchema.safeParse({ ...definition, runtime: { ...definition.runtime, api: { type: "port", env: "pOrt" } } }).success).toBe(false);
    expect(workspaceDefinitionSchema.safeParse({ ...definition, runtime: { ...definition.runtime, postgres: { type: "postgres", env: "DATABASE_URL", version: "18" } } }).success).toBe(false);
  });
  it("keeps ordinary sessions unchanged and requires selected declarations for opt-in", async () => {
    await expect(createSession(fixture.source, { store: fixture.store, runtime: true })).rejects.toThrow(/requires resources/);
    await defineRuntime();
    const normal = await createSession(fixture.source, { store: fixture.store, storage: "clone" });
    expect(normal.runtime).toBeUndefined();
    await expect(fs.stat(path.join(fixture.home, "session-runtime-ports.json"))).rejects.toThrow(/ENOENT/);
  });
  it("allocates distinct ports across stores, injects them at launch, reports availability, and releases leases only at GC", async () => {
    await defineRuntime(); vi.stubEnv("PORT", "1"); vi.stubEnv("API_PORT", undefined);
    const [a, b] = await Promise.all([
      createSession(fixture.source, { store: fixture.store, storage: "clone", runtime: true }),
      createSession(fixture.source, { store: path.join(fixture.root, "second-store"), storage: "clone", runtime: true }),
    ]);
    expect(new Set([...a.runtime!.ports, ...b.runtime!.ports].map((item) => item.port)).size).toBe(4);
    const script = `const net=require('node:net'); const s=net.createServer(); s.on('error',()=>process.exit(1)); s.listen(Number(process.env.PORT),'127.0.0.1',()=>s.close(()=>process.exit(process.env.PORT === '${a.runtime!.ports[0]!.port}' && process.env.API_PORT === '${a.runtime!.ports[1]!.port}' ? 0 : 2)));`;
    expect((await runSession(a.id, [process.execPath, "-e", script], { store: a.store, stdio: "ignore" })).code).toBe(0);
    const diagnostics = JSON.parse((await execa(process.execPath, ["--import", "tsx", path.resolve("src/index.ts"), "inspect", a.root, "--json"])).stdout);
    expect(diagnostics.workspace.ready).toBe(true);
    expect(diagnostics.environment.every((item: { availableFrom: string }) => item.availableFrom === "session")).toBe(true);
    await releaseSession(a.id, { store: a.store });
    expect(JSON.parse(await fs.readFile(path.join(fixture.home, "session-runtime-ports.json"), "utf8")).leases).toHaveLength(2);
    const preview = await gcSessions({ store: a.store });
    expect(preview.sessions[0]!.action).toBe("would-remove");
    await gcSessions({ store: a.store, apply: true });
    expect(JSON.parse(await fs.readFile(path.join(fixture.home, "session-runtime-ports.json"), "utf8")).leases.map((item: { session: string }) => item.session)).toEqual([b.id]);
    expect((await inspectSession(b.id, b.store)).runtime!.ports).toHaveLength(2);
  }, process.platform === "win32" ? 60_000 : 20_000);
  it("refuses occupied ports and repairs an interrupted lease publication", async () => {
    await defineRuntime();
    const a = await createSession(fixture.source, { store: fixture.store, storage: "clone", runtime: true });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(a.runtime!.ports[0]!.port, "127.0.0.1", resolve));
    try { await expect(runSession(a.id, [process.execPath, "-e", "process.exit(0)"], { store: a.store, stdio: "ignore" })).rejects.toThrow(/occupied/); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    await fs.rm(path.join(fixture.home, "session-runtime-ports.json"));
    expect((await runSession(a.id, [process.execPath, "-e", "process.exit(0)"], { store: a.store, stdio: "ignore" })).code).toBe(0);
    expect(JSON.parse(await fs.readFile(path.join(fixture.home, "session-runtime-ports.json"), "utf8")).leases).toHaveLength(1);
  });
});
