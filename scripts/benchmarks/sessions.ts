import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execa } from "execa";
import { stringify } from "yaml";
import { createSession, gcSessions, releaseSession } from "../../src/core/sessions";
import { probeCow, requireGit } from "../../src/core/sessionStorage";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "boot-session-benchmark-"));
const mount = path.join(temporary, "volume");
const image = path.join(temporary, "benchmark.sparseimage");
let mounted = false;
const previousBootHome = process.env.BOOT_HOME;
try {
  if (process.platform !== "darwin") throw new Error("This benchmark creates an isolated APFS image. On Linux, use an isolated reflink filesystem and the same statfs measurement protocol described in docs/sessions.md.");
  await fs.mkdir(mount);
  console.log("Creating a disposable APFS volume for physical allocation measurements.");
  await execa("hdiutil", ["create", "-size", "8g", "-type", "SPARSE", "-fs", "APFS", "-volname", "BootSessionBenchmark", image]);
  await execa("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]);
  mounted = true;
  const source = path.join(mount, "prepared-project");
  await fs.mkdir(source);
  process.env.BOOT_HOME = path.join(temporary, "boot-home");
  const capability = await probeCow(mount, mount);
  if (!capability.backend) throw new Error(capability.reason!);
  await requireGit(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "benchmark", name: "Benchmark" }, repositories: { app: { path: "." } }, profiles: { agent: { repositories: "all" } } }));
  await fs.writeFile(path.join(source, ".gitignore"), ".boot/\nnode_modules/\n");
  await fs.writeFile(path.join(source, "index.js"), "import { stringify } from 'yaml'; console.log(stringify({prepared:true}));\n");
  await fs.copyFile(path.join(projectRoot, "package.json"), path.join(source, "package.json"));
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "prepared benchmark project"]);
  console.log("Preparing real Boot dependencies on the isolated volume (one full initial copy).");
  const preparationStart = performance.now();
  await fs.cp(path.join(projectRoot, "node_modules"), path.join(source, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  const payload = path.join(source, "node_modules", "boot-benchmark-payload.bin");
  const handle = await fs.open(payload, "wx");
  for (let index = 0; index < 128; index++) await handle.write(randomBytes(1024 * 1024));
  await handle.close();
  await execa(process.execPath, ["index.js"], { cwd: source });
  const preparationMs = performance.now() - preparationStart;
  async function allocated() {
    await execa("sync");
    // A clean unmount commits APFS's delayed allocation/free transactions.
    // Reading statfs immediately after sync alone can report negative growth.
    await execa("hdiutil", ["detach", mount]); mounted = false;
    await execa("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]); mounted = true;
    const stat = await fs.statfs(mount, { bigint: true });
    return Number((stat.blocks - stat.bfree) * stat.bsize);
  }
  async function logical(directory: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { const child = await logical(target); bytes += child.bytes; files += child.files; }
      else if (entry.isFile()) { bytes += (await fs.stat(target)).size; files++; }
    }
    return { bytes, files };
  }
  const dependencies = await logical(path.join(source, "node_modules"));
  const rows = [];
  for (const count of [1, 4, 8]) {
    const store = path.join(mount, `store-${count}`);
    const before = await allocated();
    const sessions = [];
    const latencies = [];
    for (let index = 0; index < count; index++) {
      const start = performance.now();
      sessions.push(await createSession(source, { name: `bench-${count}-${index}`, storage: "cow", store, include: ["node_modules"] }));
      latencies.push(performance.now() - start);
      console.log(`Created ${index + 1}/${count} sessions (${latencies.at(-1)!.toFixed(0)} ms).`);
    }
    const afterCreate = await allocated();
    for (const session of sessions) {
      const file = await fs.open(path.join(session.root, "node_modules", "boot-benchmark-payload.bin"), "r+");
      await file.write(randomBytes(1024 * 1024), 0, 1024 * 1024, 0); await file.close();
    }
    const afterEdits = await allocated();
    for (const session of sessions) {
      await releaseSession(session.id, { store });
      await gcSessions({ store, session: session.id, discardWork: session.id, apply: true });
    }
    const afterGc = await allocated();
    if (afterCreate < before || afterEdits < afterCreate || afterGc > afterEdits) throw new Error("APFS allocation did not settle monotonically; do not publish these measurements.");
    rows.push({ sessions: count, creationMs: latencies, seedAndSessionsPhysicalBytes: afterCreate - before,
      physicalGrowthAfterEditsBytes: afterEdits - afterCreate, reclaimedBytes: afterEdits - afterGc, retainedOverheadBytes: afterGc - before });
    console.log(JSON.stringify(rows.at(-1)));
  }
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    node: process.version, backend: capability.backend, measurement: "allocated blocks from statfs on a dedicated APFS disk image; sync and clean unmount/remount before each measurement to commit delayed allocations; includes seed and session metadata; does not sum directory sizes",
    sourcePreparationMs: preparationMs, dependencies, rows };
  const output = path.join(projectRoot, "docs", "session-benchmark-results.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved measurements to ${output}`);
} finally {
  if (previousBootHome === undefined) delete process.env.BOOT_HOME; else process.env.BOOT_HOME = previousBootHome;
  if (mounted) await execa("hdiutil", ["detach", mount]);
  await fs.rm(temporary, { recursive: true, force: true });
}
