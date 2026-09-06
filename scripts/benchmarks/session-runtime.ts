import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { stringify } from "yaml";
import { createSession, gcSessions, releaseSession } from "../../src/core/sessions";
import { runSession } from "../../src/core/sessionRun";
import { listSessionRecords, type SessionRecord } from "../../src/core/sessionStore";
import { requireGit } from "../../src/core/sessionStorage";
import { daemonIdentity, docker, mustDocker } from "../../src/core/sessionDocker";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "boot-runtime-benchmark-"));
const previousBootHome = process.env.BOOT_HOME;
let cleanupComplete = true;

// Each process uses only its injected database URL and application port. SQL
// authenticates from the host. Passwords stay in subprocess environment, never
// command arguments, reports, diagnostic output, or workspace files.
const worker = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
const [barrier, mode] = process.argv.slice(2);
const id = process.env.BOOT_SESSION_ID;
if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid fixture session.');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1') throw new Error('Database must be local.');
const server = net.createServer(socket => socket.end('ready'));
await new Promise((resolve,reject) => {server.once('error',reject);server.listen(Number(process.env.PORT),'127.0.0.1',resolve);});
function sql(statement) {
  const result = spawnSync('psql', ['-X','--no-password','-h',url.hostname,'-p',url.port,'-U','boot','-d','boot','-v','ON_ERROR_STOP=1','-Atc',statement], {
    env:{...process.env, PGPASSWORD:url.password, PGCONNECT_TIMEOUT:'10', PGSSLMODE:'disable'}, encoding:'utf8', timeout:30000,
  });
  if (result.status !== 0) throw new Error('Authenticated fixture SQL failed.');
  return result.stdout.trim().split(/\r?\n/).at(-1);
}
try {
  if (mode === 'work') {
    if (sql("SELECT to_regclass('public.bench_rows') IS NULL;") !== 't') throw new Error('Database was not empty.');
    await fs.writeFile(path.join(process.cwd(),'.boot','benchmark-ready.json'),JSON.stringify({readyAt:Date.now()}));
    const deadline = Date.now()+90000;
    for (;;) {
      const signal = await fs.readFile(barrier,'utf8').catch(error => {if(error.code==='ENOENT') return null;throw error;});
      if (signal) {if(JSON.parse(signal).abort) throw new Error('Fixture aborted.');break;}
      if (Date.now()>deadline) throw new Error('Fixture launch barrier timed out.');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const startedAt=Date.now();
    sql("BEGIN; CREATE TABLE bench_rows(worker text, value integer, fingerprint text); INSERT INTO bench_rows SELECT '"+id+"', n, md5(repeat('"+id+"',50)||n::text) FROM generate_series(1,10000) n; COMMIT;");
    if(sql("SELECT count(*)||'|'||min(worker)||'|'||count(DISTINCT worker) FROM bench_rows;") !== '10000|'+id+'|1') throw new Error('Database isolation check failed.');
    await fs.writeFile(path.join(process.cwd(),'.boot','benchmark-result.json'),JSON.stringify({rows:10000,startedAt,finishedAt:Date.now()}));
  } else if (mode === 'verify') {
    if(sql("SELECT count(*)||'|'||min(worker)||'|'||count(DISTINCT worker) FROM bench_rows;") !== '10000|'+id+'|1') throw new Error('Database persistence check failed.');
  } else throw new Error('Unknown fixture mode.');
} finally {await new Promise(resolve=>server.close(resolve));}
`;

function memoryBytes(value: string): number {
  const match = /^([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB)\s*\//.exec(value);
  if (!match) throw new Error("Cannot parse owned-container memory measurement.");
  const units: Record<string, number> = { B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  return Number(match[1]) * units[match[2]!]!;
}

try {
  process.env.BOOT_HOME = path.join(temporary, "boot-home");
  await daemonIdentity();
  const psqlVersion = (await execa("psql", ["--version"])).stdout.trim();
  const engine = (await mustDocker(["version", "--format", "{{.Server.Version}}"])).trim();
  const image = "postgres:17-alpine";
  if ((await docker(["image", "inspect", image, "--format", "{{.Id}}"])).exitCode !== 0) await mustDocker(["pull", image], undefined, 600_000);
  const imageId = (await mustDocker(["image", "inspect", image, "--format", "{{.Id}}"])).trim();
  const source = path.join(temporary, "source");
  await fs.mkdir(source);
  await requireGit(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await fs.writeFile(path.join(source, ".gitignore"), ".boot/\n");
  await fs.writeFile(path.join(source, "worker.mjs"), worker);
  await fs.writeFile(path.join(source, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "runtime-benchmark", name: "Runtime benchmark" },
    repositories: { app: { path: "." } }, runtime: { app: { type: "port", env: "PORT" }, postgres: { type: "postgres", env: "DATABASE_URL", version: "17" } },
    profiles: { agent: { repositories: "all", runtime: "all" } } }));
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "parallel runtime benchmark fixture"]);
  const rows = [];
  for (const count of [1, 4, 8]) {
    const store = path.join(temporary, `store-${count}`), barrier = path.join(temporary, `start-${count}.json`);
    let launches: Array<Promise<void>> = [];
    console.log(`Measuring ${count} isolated PostgreSQL session(s).`);
    try {
      const provisionStart = performance.now();
      // Use one store, as in a normal project. Boot's store-lock queue is part
      // of the measured batch latency; these requests are submitted together.
      const attempts = await Promise.allSettled(Array.from({ length: count }, (_, index) => createSession(source, { name: `db-${count}-${index}`, storage: "clone", store, runtime: true })));
      const failed = attempts.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const sessions = attempts.map((result) => (result as PromiseFulfilledResult<SessionRecord>).value);
      const provisionMs = performance.now() - provisionStart;
      const ports = sessions.flatMap(session => [...session.runtime!.ports.map(port => port.port), ...session.runtime!.databases.map(database => database.port)]);
      if (new Set(ports).size !== count * 2) throw new Error("Runtime ports were not distinct.");
      const memory = (await mustDocker(["stats", "--no-stream", "--format", "{{.MemUsage}}", ...sessions.map(session => session.runtime!.databases[0]!.container)])).trim().split(/\r?\n/).map(memoryBytes);
      if (memory.length !== count) throw new Error("Incomplete owned-container memory sample.");
      let workerFailure: unknown;
      const launchStart = performance.now();
      launches = sessions.map(async session => {
        try {
          const exit = await runSession(session.id, [process.execPath, "worker.mjs", barrier, "work"], { store, stdio: "ignore" });
          if (exit.code !== 0) throw new Error("An isolated SQL worker failed.");
        } catch (error) { workerFailure = error; throw error; }
      });
      for (const launch of launches) void launch.catch(() => {});
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (workerFailure) throw workerFailure;
        const ready = await Promise.all(sessions.map(session => fs.stat(path.join(session.root, ".boot", "benchmark-ready.json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })));
        if (ready.every(Boolean)) break;
        if (Date.now() > deadline) throw new Error("Parallel runtime readiness timed out.");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const launchUntilAllReadyMs = performance.now() - launchStart;
      const workStart = performance.now();
      await fs.writeFile(barrier, JSON.stringify({ start: true }));
      await Promise.all(launches);
      const workAndExitMs = performance.now() - workStart;
      const workers: Array<{ rows: number; startedAt: number; finishedAt: number }> = await Promise.all(sessions.map(async session => JSON.parse(await fs.readFile(path.join(session.root, ".boot", "benchmark-result.json"), "utf8"))));
      const events = workers.flatMap(result => [{ time: result.startedAt, delta: 1 }, { time: result.finishedAt, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
      let active = 0, peakConcurrentSqlWorkers = 0;
      for (const event of events) { active += event.delta; peakConcurrentSqlWorkers = Math.max(peakConcurrentSqlWorkers, active); }
      if (workers.some(result => result.rows !== 10000)) throw new Error("SQL worker results were incomplete.");
      const releaseStart = performance.now();
      for (const session of sessions) await releaseSession(session.id, { store });
      const releaseMs = performance.now() - releaseStart;
      const restartStart = performance.now();
      const restarted = await Promise.all(sessions.map(session => runSession(session.id, [process.execPath, "worker.mjs", barrier, "verify"], { store, stdio: "ignore" })));
      if (restarted.some(result => result.code !== 0)) throw new Error("Restart did not preserve isolated database contents.");
      const restartAndVerifyMs = performance.now() - restartStart;
      const cleanupStart = performance.now();
      for (const session of sessions) {
        await releaseSession(session.id, { store });
        const result = await gcSessions({ store, session: session.id, discardWork: session.id, apply: true });
        if (result.sessions[0]?.action !== "removed") throw new Error("An owned runtime session was not reclaimed.");
        for (const [kind, name] of [["container", session.runtime!.databases[0]!.container], ["volume", session.runtime!.databases[0]!.volume], ["network", session.runtime!.network!]]) {
          const names = (await mustDocker([kind!, "ls", ...(kind === "container" ? ["--all"] : []), "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"])).split(/\r?\n/);
          if (names.includes(name!)) throw new Error("An owned runtime resource survived cleanup.");
        }
      }
      const cleanupAndVerifyMs = performance.now() - cleanupStart;
      const row = { sessions: count, provisionMs, launchUntilAllReadyMs, workAndExitMs, releaseMs, restartAndVerifyMs, cleanupAndVerifyMs,
        idleDatabaseMemoryBytes: memory.reduce((sum, bytes) => sum + bytes, 0), peakConcurrentSqlWorkers, successfulWorkers: workers.length, rowsPerWorker: 10000,
        workerSqlMs: workers.map(result => result.finishedAt - result.startedAt), persistenceVerified: true, cleanupVerified: true };
      rows.push(row); console.log(JSON.stringify(row));
    } finally {
      await fs.writeFile(barrier, JSON.stringify({ abort: true }));
      await Promise.allSettled(launches);
      for (const session of await listSessionRecords(store)) {
        try {
          if (["ready", "released"].includes(session.state)) await releaseSession(session.id, { store });
          const result = await gcSessions({ store, session: session.id, discardWork: session.id, apply: true });
          if (result.sessions[0]?.action !== "removed") throw new Error("Owned runtime resources remain protected.");
        } catch { cleanupComplete = false; }
      }
      if (!cleanupComplete) throw new Error(`Benchmark cleanup requires recovery from its owned store: ${store}`);
    }
  }
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), implementationCommit: (await requireGit(projectRoot, ["rev-parse", "HEAD"])).trim(),
    platform: process.platform, architecture: process.arch, node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), engine, image, imageId, psqlVersion,
    methodology: "One local sample per count using a minimal prepared repository and clone storage. Docker image preparation is excluded. Concurrent create/run requests share one Boot store, including store-lock queue time. All workers bind their assigned app port and authenticate from the host before a barrier starts independent 10,000-row SQL transactions. Work duration includes process exit and Boot bookkeeping; it is not AI inference or a general PostgreSQL throughput benchmark. Idle container memory is a single Docker stats sample before launch. Release/restart verifies persisted, session-specific rows. Exact owned container, volume, and network removal is verified.", rows };
  const output = path.join(projectRoot, "docs", "session-runtime-benchmark-results.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${output}`);
} finally {
  if (previousBootHome === undefined) delete process.env.BOOT_HOME; else process.env.BOOT_HOME = previousBootHome;
  if (cleanupComplete) await fs.rm(temporary, { recursive: true, force: true });
}
