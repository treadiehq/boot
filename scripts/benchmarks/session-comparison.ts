import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { execa } from "execa";
import { stringify } from "yaml";
import { createSession, gcSessions, releaseSession } from "../../src/core/sessions";
import { runSession } from "../../src/core/sessionRun";
import { probeCow, requireGit } from "../../src/core/sessionStorage";
import type { SessionRecord } from "../../src/core/sessionStore";

// Prepared-state comparison: no package downloads, installs, or AI inference.
// Plain Git baselines get identical dependency bytes through ordinary writes.
// Boot includes its managed seed, metadata, and launch bookkeeping in timing.
const projectRoot = path.resolve(import.meta.dirname, "../..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "boot-session-comparison-"));
const mount = path.join(temporary, "volume"), image = path.join(temporary, "comparison.sparseimage");
const previousBootHome = process.env.BOOT_HOME;
let mounted = false;
type Mode = "boot-cow" | "git-worktree" | "git-clone";

async function byteCopy(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    if (path.isAbsolute(link)) throw new Error("The dependency fixture must be relocatable.");
    await fs.symlink(link, destination);
  } else if (stat.isDirectory()) {
    await fs.mkdir(destination, { mode: stat.mode });
    for (const entry of await fs.readdir(source)) await byteCopy(path.join(source, entry), path.join(destination, entry));
  } else if (stat.isFile()) {
    // Do not use copyfile/cp: explicitly write bytes to rule out accidental CoW
    // or hard-link sharing in the full-copy baselines.
    if (stat.size > 8 * 1024 * 1024) await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx", mode: stat.mode }));
    else await fs.writeFile(destination, await fs.readFile(source), { flag: "wx", mode: stat.mode });
  } else throw new Error("Unsupported dependency fixture file.");
}

async function logical(directory: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { const child = await logical(file); bytes += child.bytes; files += child.files; }
    else if (entry.isFile()) { bytes += (await fs.stat(file)).size; files++; }
  }
  return { bytes, files };
}

try {
  if (process.platform !== "darwin") throw new Error("This comparison requires macOS/APFS for isolated physical-allocation measurements.");
  await fs.mkdir(mount);
  await execa("hdiutil", ["create", "-size", "16g", "-type", "SPARSE", "-fs", "APFS", "-volname", "BootSessionComparison", image]);
  await execa("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]); mounted = true;
  process.env.BOOT_HOME = path.join(temporary, "boot-home");
  const capability = await probeCow(mount, mount);
  if (!capability.backend) throw new Error(capability.reason!);
  const source = path.join(mount, "prepared-project");
  await fs.mkdir(source);
  await requireGit(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "comparison", name: "Comparison" }, repositories: { app: { path: "." } }, profiles: { agent: { repositories: "all" } } }));
  await fs.writeFile(path.join(source, ".gitignore"), ".boot/\nnode_modules/\n");
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "boot-benchmark-fixture", private: true, type: "module" }));
  await fs.writeFile(path.join(source, "index.js"), "import { stringify } from 'yaml'; if (!stringify({prepared:true}).includes('true')) process.exit(1);\n");
  // A tracked incompressible corpus makes the Git object/checkout costs visible.
  await fs.writeFile(path.join(source, "tracked-payload.bin"), randomBytes(32 * 1024 * 1024));
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "prepared comparison fixture"]);
  const preparationStart = performance.now();
  console.log("Preparing identical dependencies with ordinary byte copies.");
  await byteCopy(path.join(projectRoot, "node_modules"), path.join(source, "node_modules"));
  const payload = path.join(source, "node_modules", "boot-benchmark-payload.bin");
  const handle = await fs.open(payload, "wx");
  for (let index = 0; index < 128; index++) await handle.write(randomBytes(1024 * 1024));
  await handle.close();
  await execa(process.execPath, ["index.js"], { cwd: source });
  const preparationMs = performance.now() - preparationStart;
  const dependencies = await logical(path.join(source, "node_modules"));
  const prefix = async (file: string) => {
    const handle = await fs.open(file, "r");
    try { const buffer = Buffer.alloc(1024 * 1024); await handle.read(buffer, 0, buffer.length, 0); return createHash("sha256").update(buffer).digest("hex"); }
    finally { await handle.close(); }
  };
  const originalPrefix = await prefix(payload);
  async function allocated() {
    await execa("sync");
    await execa("hdiutil", ["detach", mount]); mounted = false;
    await execa("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]); mounted = true;
    const stat = await fs.statfs(mount, { bigint: true });
    return Number((stat.blocks - stat.bfree) * stat.bsize);
  }
  const rows = [];
  const modes: Mode[] = ["boot-cow", "git-worktree", "git-clone"];
  for (const [batch, count] of [1, 4, 8].entries()) {
    // Rotate ordering to avoid always giving the same method the warmest cache.
    for (const mode of [...modes.slice(batch), ...modes.slice(0, batch)]) {
      const group = path.join(mount, `${mode}-${count}`), store = path.join(group, "store");
      const before = await allocated();
      await fs.mkdir(group);
      const workspaces: Array<{ root: string; session?: SessionRecord }> = [];
      const creationMs: number[] = [], readyMs: number[] = [], launchMs: number[] = [];
      for (let index = 0; index < count; index++) {
        const start = performance.now();
        let workspace: { root: string; session?: SessionRecord };
        if (mode === "boot-cow") {
          const session = await createSession(source, { name: `compare-${count}-${index}`, storage: "cow", store, include: ["node_modules"] });
          workspace = { root: session.root, session };
        } else {
          workspace = { root: path.join(group, `workspace-${index}`) };
          if (mode === "git-worktree") await requireGit(source, ["worktree", "add", "--detach", workspace.root, "HEAD"]);
          else await requireGit(group, ["clone", "--no-local", "--", source, workspace.root]);
          await byteCopy(path.join(source, "node_modules"), path.join(workspace.root, "node_modules"));
        }
        creationMs.push(performance.now() - start);
        workspaces.push(workspace);
        const launchStart = performance.now();
        if (workspace.session) {
          const result = await runSession(workspace.session.id, [process.execPath, "index.js"], { store, stdio: "ignore" });
          if (result.code !== 0) throw new Error("The prepared Boot workspace could not run its dependency smoke check.");
        } else await execa(process.execPath, ["index.js"], { cwd: workspace.root });
        launchMs.push(performance.now() - launchStart);
        readyMs.push(performance.now() - start);
        if (await prefix(path.join(workspace.root, "node_modules", "boot-benchmark-payload.bin")) !== originalPrefix) throw new Error("A workspace did not receive the original dependency bytes.");
        console.log(`${mode}: ${index + 1}/${count} ready in ${readyMs.at(-1)!.toFixed(0)} ms`);
      }
      const afterCreate = await allocated();
      for (const workspace of workspaces) {
        const handle = await fs.open(path.join(workspace.root, "node_modules", "boot-benchmark-payload.bin"), "r+");
        try { const bytes = randomBytes(1024 * 1024); await handle.write(bytes, 0, bytes.length, 0); }
        finally { await handle.close(); }
      }
      if (await prefix(payload) !== originalPrefix) throw new Error("A workspace changed the source dependency bytes.");
      const editedPrefixes = await Promise.all(workspaces.map((workspace) => prefix(path.join(workspace.root, "node_modules", "boot-benchmark-payload.bin"))));
      if (new Set(editedPrefixes).size !== count || editedPrefixes.includes(originalPrefix)) throw new Error("Workspace edits were not independent.");
      const afterEdits = await allocated();
      const cleanupStart = performance.now();
      for (const workspace of workspaces) {
        if (workspace.session) {
          await releaseSession(workspace.session.id, { store });
          const result = await gcSessions({ store, session: workspace.session.id, discardWork: workspace.session.id, apply: true });
          if (result.sessions[0]?.action !== "removed") throw new Error("Owned comparison session was not reclaimed.");
        } else if (mode === "git-worktree") await requireGit(source, ["worktree", "remove", "--force", workspace.root]);
        else await fs.rm(workspace.root, { recursive: true });
      }
      const cleanupMs = performance.now() - cleanupStart;
      const afterGc = await allocated();
      if (afterCreate < before || afterGc > afterEdits) throw new Error("Physical allocation did not settle; do not publish this run.");
      const row = { mode, sessions: count, creationMs, readyMs, launchMs, cleanupMs, physicalGrowthBytes: afterCreate - before,
        growthAfterEditsBytes: afterEdits - afterCreate, reclaimedBytes: afterEdits - afterGc, retainedOverheadBytes: afterGc - before };
      rows.push(row); console.log(JSON.stringify(row));
    }
  }
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), implementationCommit: (await requireGit(projectRoot, ["rev-parse", "HEAD"])).trim(),
    platform: process.platform, architecture: process.arch, node: process.version, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
    backend: capability.backend, trackedPayloadBytes: 32 * 1024 * 1024, dependencies, preparationMs,
    methodology: "One local sample per mode/count, rotated mode order, prepared dependencies with network/install time excluded. Each batch starts with a fresh store; Boot seed creation is included. Ready means a new process successfully imported yaml. Boot uses its Node API and managed launch; plain Git uses direct Node launch. Full-copy dependency baselines use ordinary writes, never reflinks/hard links. Physical volume allocation is measured after clean unmount/remount; source preparation and global Boot registry/helper cache are outside the per-batch baseline. No AI inference is measured.", rows };
  const output = path.join(projectRoot, "docs", "session-comparison-results.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Saved ${output}`);
} finally {
  if (previousBootHome === undefined) delete process.env.BOOT_HOME; else process.env.BOOT_HOME = previousBootHome;
  if (mounted) await execa("hdiutil", ["detach", mount]);
  await fs.rm(temporary, { recursive: true, force: true });
}
