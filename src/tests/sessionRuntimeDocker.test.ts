import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { execa } from "execa";
import { sessionFixture } from "./sessionFixture";
import { createSession, inspectSession, releaseSession, gcSessions } from "../core/sessions";
import { runSession } from "../core/sessionRun";
import { startRuntime } from "../core/sessionRuntime";
import * as store from "../core/sessionStore";
import { requireGit } from "../core/sessionStorage";

// Opt-in: creates only UUID-named test resources, with exact cleanup below.
const integration = process.env.BOOT_TEST_DOCKER === "1" ? describe : describe.skip;
// Keep direct verification commands on the fixture context even when testing
// Boot with a deliberately conflicting inherited DOCKER_HOST.
const dockerArgs = (args: string[]) => process.env.DOCKER_CONTEXT ? ["--context", process.env.DOCKER_CONTEXT, ...args] : args;
integration("real local PostgreSQL runtimes", () => {
  let fixture: Awaited<ReturnType<typeof sessionFixture>>;
  beforeEach(async () => {
    fixture = await sessionFixture(); vi.stubEnv("BOOT_HOME", fixture.home);
    const definition = parse(await fs.readFile(path.join(fixture.source, "boot.yaml"), "utf8"));
    definition.runtime = { web: { type: "port", env: "PORT" }, postgres: { type: "postgres", env: "DATABASE_URL", version: "17" } };
    definition.services = { postgres: { type: "postgres", check: "false" } };
    definition.env = { required: [{ name: "DATABASE_URL", source: "boot", secret: true }] };
    definition.profiles.agent.runtime = "all";
    await fs.writeFile(path.join(fixture.source, "boot.yaml"), stringify(definition));
    await requireGit(fixture.source, ["add", "boot.yaml"]);
    await requireGit(fixture.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "runtime"]);
  });
  afterEach(async () => {
    const ownedFixture = fixture;
    vi.restoreAllMocks();
    for (const record of await store.listSessionRecords(ownedFixture.store)) {
      if (["ready", "released"].includes(record.state)) await releaseSession(record.id, { store: record.store });
      await gcSessions({ store: record.store, apply: true, session: record.id, discardWork: record.id });
    }
    vi.unstubAllEnvs(); await fs.rm(ownedFixture.root, { recursive: true, force: true });
  }, 120_000);
  const create = (name: string) => createSession(fixture.source, { name, store: fixture.store, storage: "clone", runtime: true });
  async function sql(record: store.SessionRecord, statement: string) {
    const environment = await startRuntime(record);
    const connection = new URL(environment.DATABASE_URL!);
    // Windows must authenticate from the host through its published localhost
    // port. Executing psql only inside Docker would miss forwarding failures.
    const command = process.platform === "win32" ? process.env.BOOT_TEST_PSQL ?? "psql" : "docker";
    const args = process.platform === "win32"
      ? ["-h", connection.hostname, "-p", connection.port]
      : ["container", "exec", "--env", "PGPASSWORD", record.runtime!.databases[0]!.container, "psql", "-h", "127.0.0.1"];
    const sqlArgs = [...args, "-X", "--no-password", "-U", "boot", "-d", "boot", "-v", "ON_ERROR_STOP=1", "-Atc", statement];
    const result = await execa(command, process.platform === "win32" ? sqlArgs : dockerArgs(sqlArgs), {
      env: { PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: "10", PGSSLMODE: "disable" }, reject: false, timeout: 30_000,
    }).catch(() => { throw new Error("Test SQL client could not run."); });
    // Do not print subprocess configuration or connection credentials on error.
    if (result.exitCode !== 0) throw new Error("Test SQL failed.");
    return result.stdout;
  }
  it("gives two agents distinct databases and ports, preserves data across release, and removes only owned resources", async () => {
    vi.stubEnv("DATABASE_URL", "synthetic-inherited-connection-must-be-overridden");
    const a = await create("agent-a"), b = await create("agent-b");
    expect(new Set([a, b].flatMap((record) => [...record.runtime!.ports.map((port) => port.port), ...record.runtime!.databases.map((db) => db.port)])).size).toBe(4);
    expect(a.runtime!.ports[0]!.port).not.toBe(b.runtime!.ports[0]!.port);
    expect(a.definition.services).toEqual({});
    const inspect = JSON.stringify(await inspectSession(a.id, a.store));
    const env = await startRuntime(a);
    expect(inspect.includes(env.DATABASE_URL!)).toBe(false);
    expect(inspect.includes(new URL(env.DATABASE_URL!).password)).toBe(false);
    const metadata = await fs.readFile(path.join(path.dirname(a.root), "runtime-secrets.json"), "utf8");
    expect(metadata.includes(new URL(env.DATABASE_URL!).password)).toBe(false);
    const launch = (record: store.SessionRecord) => runSession(record.id, [process.execPath, "-e", `const net=require('node:net');const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.port!=='${record.runtime!.databases[0]!.port}')process.exit(2);const socket=net.connect(Number(url.port),url.hostname,()=>{socket.destroy();const app=net.createServer();app.listen(Number(process.env.PORT),'127.0.0.1',()=>setTimeout(()=>app.close(),400));});socket.on('error',()=>process.exit(3));`], { store: record.store, stdio: "ignore" });
    expect((await Promise.all([launch(a), launch(b)])).map((exit) => exit.code)).toEqual([0, 0]);
    await sql(a, "CREATE TABLE session_test(value text); INSERT INTO session_test VALUES ('agent-a');");
    expect(await sql(b, "SELECT to_regclass('public.session_test') IS NULL;")).toBe("t");
    await sql(b, "CREATE TABLE session_test(value text); INSERT INTO session_test VALUES ('agent-b');");
    await releaseSession(a.id, { store: a.store });
    expect((await inspectSession(a.id, a.store)).runtime!.databases[0]!.state).toBe("stopped");
    const preview = (await gcSessions({ store: a.store, session: a.id })).sessions[0]!;
    expect(preview.action).toBe("would-remove");
    expect(preview.runtime!.databases[0]!.volume).toBe(a.runtime!.databases[0]!.volume);
    const current = await store.findSession(a.id, a.store);
    expect((await runSession(a.id, [process.execPath, "-e", "process.exit(0)"], { store: a.store, stdio: "ignore" })).code).toBe(0);
    expect(await sql(await store.findSession(current.id, current.store), "SELECT value FROM session_test;")).toBe("agent-a");
    await releaseSession(a.id, { store: a.store });
    const removed = a.runtime!.databases[0]!;
    await gcSessions({ store: a.store, apply: true, session: a.id });
    expect((await execa("docker", dockerArgs(["container", "inspect", "--format", "{{.Id}}", removed.container]), { reject: false })).exitCode).not.toBe(0);
    expect((await execa("docker", dockerArgs(["volume", "inspect", "--format", "{{.Name}}", removed.volume]), { reject: false })).exitCode).not.toBe(0);
    expect(await sql(await store.findSession(b.id, b.store), "SELECT value FROM session_test;")).toBe("agent-b");
  }, 240_000);
  it("supports an explicitly selected PostgreSQL 16 database", async () => {
    const file = path.join(fixture.source, "boot.yaml");
    const definition = parse(await fs.readFile(file, "utf8"));
    definition.runtime.postgres.version = "16";
    await fs.writeFile(file, stringify(definition));
    await requireGit(fixture.source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-am", "PostgreSQL 16"]);
    const record = await create("postgres-16");
    expect((await sql(record, "SELECT current_setting('server_version_num');")).startsWith("16")).toBe(true);
  }, 180_000);
  it.skipIf(process.platform !== "win32" || !process.env.BOOT_TEST_WINDOWS_BINARY)("provisions and launches PostgreSQL through the standalone Windows binary", async () => {
    const binary = process.env.BOOT_TEST_WINDOWS_BINARY!;
    const created = await execa(binary, ["session", "create", fixture.source, "--name", "standalone", "--store", fixture.store, "--storage", "clone", "--runtime", "--json"], { reject: false, timeout: 120_000 });
    if (created.exitCode !== 0) throw new Error("Standalone Windows runtime creation failed.");
    const record = JSON.parse(created.stdout) as store.SessionRecord;
    const script = `const {spawnSync}=require('node:child_process');const u=new URL(process.env.DATABASE_URL);const r=spawnSync(process.env.BOOT_TEST_PSQL,['-X','--no-password','-h',u.hostname,'-p',u.port,'-U','boot','-d','boot','-v','ON_ERROR_STOP=1','-Atc',"CREATE TABLE binary_test(value text); INSERT INTO binary_test VALUES ('windows-binary');"],{env:{...process.env,PGPASSWORD:u.password,PGCONNECT_TIMEOUT:'10',PGSSLMODE:'disable'},stdio:'ignore'});process.exit(r.status??1);`;
    const launched = await execa(binary, ["session", "run", record.id, "--store", fixture.store, "--", process.execPath, "-e", script], { reject: false, timeout: 60_000 });
    expect(launched.exitCode).toBe(0);
    expect(await sql(await store.findSession(record.id, record.store), "SELECT value FROM binary_test;")).toBe("windows-binary");
  }, 180_000);
  it("refuses a different daemon and foreign replacement even with exact-session discard", async () => {
    const a = await create("ownership"); await releaseSession(a.id, { store: a.store });
    const saved = await store.findSession(a.id, a.store), daemon = saved.runtime!.daemon;
    saved.runtime!.daemon = "another-daemon"; await store.writeSession(saved);
    expect((await gcSessions({ store: a.store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("retained");
    saved.runtime!.daemon = daemon; await store.writeSession(saved);
    const db = saved.runtime!.databases[0]!;
    await execa("docker", dockerArgs(["container", "rm", db.containerId!]));
    const foreign = (await execa("docker", dockerArgs(["container", "create", "--name", db.container, "postgres:17-alpine"]))).stdout.trim();
    try {
      expect((await gcSessions({ store: a.store, apply: true, session: a.id, discardWork: a.id })).sessions[0]!.action).toBe("retained");
      expect((await execa("docker", dockerArgs(["container", "inspect", "--format", "{{.Id}}", foreign]))).stdout).toBe(foreign);
    } finally { await execa("docker", dockerArgs(["container", "rm", "--volumes", foreign])); }
  }, 120_000);
  it("recovers a container created before its ID could be journaled", async () => {
    const original = store.writeSession;
    let interrupted = false;
    vi.spyOn(store, "writeSession").mockImplementation(async (record) => {
      if (!interrupted && record.runtime?.databases.some((db) => db.containerId)) { interrupted = true; record.runtime.databases[0]!.containerId = null; throw new Error("simulated journal interruption"); }
      return original(record);
    });
    await expect(create("interrupted")).rejects.toThrow(/journal interruption/);
    vi.restoreAllMocks();
    const record = (await store.listSessionRecords(fixture.store))[0]!;
    expect(record.state).toBe("failed");
    expect(record.runtime!.databases[0]!.containerId).toBeNull();
    expect((await gcSessions({ store: record.store, apply: true, session: record.id, discardWork: record.id })).sessions[0]!.action).toBe("removed");
    expect((await execa("docker", dockerArgs(["container", "ls", "--all", "--filter", `label=co.boot.session=${record.id}`, "--format", "{{.ID}}"]))).stdout).toBe("");
  }, 120_000);
});
