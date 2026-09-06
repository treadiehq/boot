import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { stateDir } from "./identity";
import { withFileLock } from "./lock";
import { writeFileAtomic } from "./files";
import { decrypt, encrypt, encryptedBlobSchema, loadKey, loadOrCreateKey } from "./secrets";
import { readJson, writeSession, type SessionRecord } from "./sessionStore";
import { resolveWithinRoot } from "./pathUtils";
import type { RuntimeDefinition } from "./workspace";
import { docker, mustDocker, daemonIdentity } from "./sessionDocker";

const leaseSchema = z.object({ schemaVersion: z.literal(1), leases: z.array(z.object({ session: z.string().uuid(), store: z.string(), token: z.string().uuid(), ports: z.array(z.number().int()) }).strict()) }).strict();
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const leasesPath = () => path.join(stateDir(), "session-runtime-ports.json");
const secretPath = (record: SessionRecord) => resolveWithinRoot(record.store, `sessions/${record.id}/runtime-secrets.json`);
const labelsFor = (record: SessionRecord) => ({ "co.boot.session": record.id, "co.boot.store": hash(record.store), "co.boot.runtime": record.runtime!.token });

async function verifyDaemon(record: SessionRecord): Promise<void> {
  if (record.runtime?.databases.length && await daemonIdentity() !== record.runtime.daemon) throw new Error("The Docker daemon differs from this session's recorded owner. Select the original local daemon before recovery.");
}
async function ownedResource(record: SessionRecord, kind: "container" | "volume" | "network", name: string) {
  const format = kind === "container"
    ? '{{json .Id}}\n{{json .Config.Labels}}\n{{json .State.Running}}\n{{json .NetworkSettings.Ports}}'
    : kind === "network" ? '{{json .Id}}\n{{json .Labels}}' : '{{json .Name}}\n{{json .Labels}}';
  const result = await docker([kind, "inspect", "--format", format, name]);
  if (result.exitCode !== 0) {
    // A failed inspection alone does not establish absence (daemon outages
    // must never authorize deletion). Confirm via the daemon's resource list.
    const found = (await mustDocker([kind, "ls", ...(kind === "container" ? ["--all"] : []), "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"])).split(/\r?\n/);
    if (found.includes(name)) throw new Error(`Owned ${kind} ${name} cannot be inspected.`);
    return null;
  }
  const [id, labels, running, ports] = result.stdout.split("\n").map((line) => JSON.parse(line));
  for (const [key, value] of Object.entries(labelsFor(record))) if (labels?.[key] !== value) throw new Error(`Refusing foreign ${kind} ${name}: ownership labels do not match.`);
  if (kind === "container") {
    const expected = record.runtime!.databases.find((db) => db.container === name)?.containerId;
    if (expected && expected !== id) throw new Error("The session database container was replaced; retain it for manual review.");
  }
  return { id: id as string, running: Boolean(running), ports: ports as Record<string, Array<{ HostIp: string; HostPort: string }> | null> | undefined };
}

async function withLeases<T>(fn: (data: z.infer<typeof leaseSchema>) => Promise<T>): Promise<T> {
  return withFileLock(path.join(stateDir(), "session-runtime-ports.lock"), "allocating session ports", async () => {
    const data = leaseSchema.parse(await readJson(leasesPath()) ?? { schemaVersion: 1, leases: [] });
    const result = await fn(data);
    await writeFileAtomic(leasesPath(), JSON.stringify(data), { mode: 0o600 });
    return result;
  }, { staleAfterMs: 1000 });
}
function bind(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once("error", reject);
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(server));
  });
}
function close(server: net.Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
async function allocatePorts(record: SessionRecord, resources: Record<string, RuntimeDefinition>) {
  await withLeases(async (data) => {
    const used = new Set(data.leases.flatMap((lease) => lease.ports));
    const ports = [];
    const leasedPorts: number[] = [];
    for (const [id, definition] of Object.entries(resources)) {
      let port = 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        const server = await bind(0); const candidate = (server.address() as net.AddressInfo).port; await close(server);
        if (!used.has(candidate) && candidate >= 1024) { port = candidate; break; }
      }
      if (!port) throw new Error("Could not allocate distinct session application ports.");
      used.add(port); leasedPorts.push(port);
      if (definition.type === "port") ports.push({ id, env: definition.env, port });
      else record.runtime!.databases.find((database) => database.id === id)!.port = port;
    }
    record.runtime!.ports = ports;
    // Journal first. Launch repairs an interrupted publication under the same
    // global lock, refusing any port subsequently leased by another session.
    await writeSession(record);
    data.leases.push({ session: record.id, store: record.store, token: record.runtime!.token, ports: leasedPorts });
  });
}

export async function provisionRuntime(record: SessionRecord, definitions: Record<string, RuntimeDefinition>): Promise<void> {
  if (!Object.keys(definitions).length) throw new Error("--runtime requires resources declared in boot.yaml and selected by the active profile.");
  const suffix = record.id.replaceAll("-", "");
  const databases = Object.entries(definitions).filter(([, resource]) => resource.type === "postgres").map(([id, resource]) => ({
    id, env: resource.env, version: (resource as Extract<RuntimeDefinition, { type: "postgres" }>).version,
    container: `boot-${suffix}-${hash(id).slice(0, 8)}`, containerId: null, volume: `boot-${suffix}-${hash(id).slice(0, 8)}-data`, port: null,
  }));
  record.runtime = { schemaVersion: 1, token: randomUUID(), daemon: null, network: databases.length ? `boot-${suffix}` : null, ports: [], databases };
  await writeSession(record);
  await allocatePorts(record, definitions);
  if (!databases.length) return;
  record.runtime.daemon = await daemonIdentity(); await writeSession(record);
  const secrets = Object.fromEntries(databases.map((db) => [db.id, randomBytes(32).toString("hex")]));
  const { key } = await loadOrCreateKey();
  await writeFileAtomic(secretPath(record), JSON.stringify(encrypt(JSON.stringify(secrets), key)), { mode: 0o600 });
  const labels = Object.entries(labelsFor(record)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  if (await ownedResource(record, "network", record.runtime.network!)) throw new Error("Runtime network already exists; use session recovery before retrying.");
  await mustDocker(["network", "create", ...labels, record.runtime.network!]);
  await ownedResource(record, "network", record.runtime.network!);
  for (const database of record.runtime.databases) {
    if (await ownedResource(record, "volume", database.volume)) throw new Error("Runtime data volume already exists.");
    await mustDocker(["volume", "create", ...labels, database.volume]);
    await ownedResource(record, "volume", database.volume);
    const image = `postgres:${database.version}-alpine`;
    if ((await docker(["image", "inspect", image, "--format", "{{.Id}}"])).exitCode !== 0) await mustDocker(["pull", image], undefined, 600_000);
    if (await ownedResource(record, "container", database.container)) throw new Error("Runtime database container already exists.");
    database.containerId = (await mustDocker(["container", "create", "--name", database.container, ...labels,
      "--network", record.runtime.network!, "--publish", `127.0.0.1:${database.port}:5432`, "--mount", `type=volume,src=${database.volume},dst=/var/lib/postgresql/data`,
      "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_USER=boot", "--env", "POSTGRES_DB=boot", image], { POSTGRES_PASSWORD: secrets[database.id]! })).trim();
    await writeSession(record);
  }
  await startRuntime(record);
}

async function credentials(record: SessionRecord): Promise<Record<string, string>> {
  const raw = encryptedBlobSchema.parse(await readJson(secretPath(record)));
  return z.record(z.string(), z.string()).parse(JSON.parse(decrypt(raw, await loadKey())));
}
export async function startRuntime(record: SessionRecord): Promise<Record<string, string>> {
  if (!record.runtime) return {};
  await verifyDaemon(record);
  await withLeases(async (data) => {
    const ours = (lease: z.infer<typeof leaseSchema>["leases"][number]) => lease.session === record.id && lease.store === record.store && lease.token === record.runtime!.token;
    const used = new Set(data.leases.filter((lease) => !ours(lease)).flatMap((lease) => lease.ports));
    const ports = [...record.runtime!.ports.map((item) => item.port), ...record.runtime!.databases.map((item) => item.port).filter((port): port is number => port !== null)];
    if (ports.some((port) => used.has(port))) throw new Error("A session application port was leased elsewhere during interrupted allocation; create a new session.");
    data.leases = data.leases.filter((lease) => !ours(lease));
    data.leases.push({ session: record.id, store: record.store, token: record.runtime!.token, ports });
  });
  const environment: Record<string, string> = {};
  // These are cooperative leases, not socket activation: a non-Boot process
  // can still take the port after this check. Refuse known conflicts.
  for (const item of record.runtime.ports) {
    try { const socket = await bind(item.port); await close(socket); }
    catch { throw new Error(`Application port ${item.port} is occupied. Stop its owner or create a new session before launching.`); }
    environment[item.env] = String(item.port);
  }
  const passwords = record.runtime.databases.length ? await credentials(record) : {};
  for (const database of record.runtime.databases) {
    if (!await ownedResource(record, "network", record.runtime.network!) || !await ownedResource(record, "volume", database.volume)) throw new Error("Session database network or data volume is missing; resources are retained for recovery.");
    let info = await ownedResource(record, "container", database.container);
    if (!info) throw new Error("The session database is missing; retain its volume for recovery.");
    if (!info.running) await mustDocker(["container", "start", database.container]);
    const deadline = Date.now() + 90_000;
    while ((await docker(["container", "exec", database.container, "pg_isready", "-h", "127.0.0.1", "-U", "boot", "-d", "boot"])).exitCode !== 0) {
      if (Date.now() >= deadline) throw new Error("Session PostgreSQL did not become ready within 90 seconds; resources are retained.");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    info = await ownedResource(record, "container", database.container);
    const bindings = info?.ports?.["5432/tcp"];
    if (bindings?.length !== 1 || bindings[0]!.HostIp !== "127.0.0.1" || Number(bindings[0]!.HostPort) !== database.port) throw new Error("Database publishing does not match the required loopback-only binding.");
    if (!passwords[database.id]) throw new Error("Session database credentials are unavailable.");
    environment[database.env] = `postgresql://boot:${passwords[database.id]}@127.0.0.1:${database.port}/boot`;
  }
  await writeSession(record);
  return environment;
}

export async function inspectRuntime(record: SessionRecord) {
  if (!record.runtime) return undefined;
  const databases: Array<{ id: string; state: string; port: number | null }> = [];
  const protection: string[] = [];
  try {
    await verifyDaemon(record);
    if (record.runtime.network && !await ownedResource(record, "network", record.runtime.network)) protection.push("runtime network is missing");
    for (const db of record.runtime.databases) {
      const volume = await ownedResource(record, "volume", db.volume);
      const container = await ownedResource(record, "container", db.container);
      if (!volume || !container) protection.push(`runtime database ${db.id} is incomplete`);
      if (container?.running && record.state === "released") protection.push(`released runtime database ${db.id} was restarted externally; release it again before cleanup`);
      databases.push({ id: db.id, state: container ? container.running ? "running" : "stopped" : "missing", port: db.port });
    }
  } catch (error) { protection.push(error instanceof Error ? error.message : "Runtime ownership cannot be verified."); }
  return { ports: record.runtime.ports, databases, protection };
}

export async function stopRuntime(record: SessionRecord): Promise<void> {
  if (!record.runtime?.databases.length || !record.runtime.daemon) return;
  await verifyDaemon(record);
  for (const db of record.runtime.databases) {
    const owned = await ownedResource(record, "container", db.container);
    if (owned?.running) await mustDocker(["container", "stop", "--time", "10", db.container]);
  }
}

async function validateCleanup(record: SessionRecord, recovering: boolean): Promise<void> {
  if (!record.runtime?.databases.length || !record.runtime.daemon) return;
  await verifyDaemon(record);
  if (record.runtime.network) await ownedResource(record, "network", record.runtime.network);
  for (const db of record.runtime.databases) {
    const container = await ownedResource(record, "container", db.container);
    await ownedResource(record, "volume", db.volume);
    if (container?.running && !recovering) throw new Error("Session database is still running; release the session before cleanup.");
  }
}
export async function runtimeCleanupReasons(record: SessionRecord): Promise<string[]> {
  try { await validateCleanup(record, ["failed", "provisioning", "deleting"].includes(record.state)); return []; }
  catch (error) { return [error instanceof Error ? error.message : "Runtime ownership cannot be verified."]; }
}

/** Recheck every label/daemon before deleting any external resource. */
export async function removeRuntime(record: SessionRecord, recovering = false): Promise<void> {
  if (!record.runtime) return;
  await validateCleanup(record, recovering);
  if (record.runtime.databases.length && record.runtime.daemon) {
    await verifyDaemon(record);
    // Validate the complete set before beginning removal.
    if (record.runtime.network) await ownedResource(record, "network", record.runtime.network);
    for (const db of record.runtime.databases) { await ownedResource(record, "container", db.container); await ownedResource(record, "volume", db.volume); }
    for (const db of record.runtime.databases) {
      if (await ownedResource(record, "container", db.container)) await mustDocker(["container", "rm", "--force", "--volumes", db.container]);
      if (await ownedResource(record, "volume", db.volume)) await mustDocker(["volume", "rm", db.volume]);
    }
    if (record.runtime.network && await ownedResource(record, "network", record.runtime.network)) await mustDocker(["network", "rm", record.runtime.network]);
  }
  await withLeases(async (data) => { data.leases = data.leases.filter((lease) => lease.session !== record.id || lease.store !== record.store || lease.token !== record.runtime!.token); });
}
