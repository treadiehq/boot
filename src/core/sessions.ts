import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { loadWorkspaceDefinition } from "./discovery";
import { resolveWorkspace, type WorkspaceDefinition } from "./workspace";
import { resolveWorkspaceRepositoryPath, resolveWithinRoot, portableRelativePathSchema, toPosix } from "./pathUtils";
import { writeFileAtomic } from "./files";
import { copyTree, excludedSnapshotPath, isWithin, probeCow, requireGit, sessionGit, treeFingerprint, type StorageRequest } from "./sessionStorage";
import { ensureStore, findSession, listSessionRecords, readJson, sessionOwner, verifyRecord, withStoreLock, writeSession, type SessionRecord, type SessionRepository } from "./sessionStore";
import { snapshotRepositories, importSubmoduleIndexes } from "./sessionSubmodules";
import { provisionRuntime, inspectRuntime, stopRuntime, removeRuntime, runtimeCleanupReasons } from "./sessionRuntime";

export interface CreateSessionOptions {
  profile?: string; name?: string; storage?: StorageRequest; store?: string;
  includeWorkingTree?: boolean; include?: string[]; runtime?: boolean;
}

function lines(value: string): string[] { return value.split("\n").filter(Boolean); }
function nul(value: string): string[] { return value.split("\0").filter(Boolean); }
async function changedPaths(directory: string): Promise<string[]> {
  return [...new Set([
    ...nul(await requireGit(directory, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z"])),
    ...nul(await requireGit(directory, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z"])),
  ])];
}
function seedPath(record: SessionRecord, repo: SessionRepository): string { return resolveWithinRoot(record.store, `seeds/${repo.seed}/repository`); }
export function sessionRepoPath(record: SessionRecord, repo: SessionRepository): string { return resolveWorkspaceRepositoryPath(record.root, repo.relativePath); }

function frozenDefinition(definition: WorkspaceDefinition, profile?: string, runtimeEnabled = false): WorkspaceDefinition {
  const resolved = resolveWorkspace(definition, profile);
  const id = resolved.profile ?? "session";
  const runtime = runtimeEnabled ? resolved.runtime ?? {} : {};
  const supplied = new Set(Object.values(runtime).map((resource) => resource.env));
  const environment = resolved.env.filter((item) => !supplied.has(item.name));
  environment.push(...Object.values(runtime).map((resource) => ({ name: resource.env, source: "session", secret: resource.type === "postgres" })));
  const services = Object.fromEntries(Object.entries(resolved.services).filter(([id]) => runtime[id]?.type !== "postgres"));
  return {
    schemaVersion: 1, workspace: definition.workspace,
    repositories: Object.fromEntries(resolved.repositories.map(({ id, ref: _ref, url: _url, ...repo }) => [id, repo])),
    tools: resolved.tools, services,
    ...(runtimeEnabled ? { runtime } : {}),
    commands: Object.fromEntries(Object.entries(resolved.commands).map(([id, { id: _id, ...command }]) => [id, command])),
    env: { required: environment }, constraints: resolved.constraints,
    profiles: { [id]: { repositories: "all", tools: "all", services: "all", commands: "all", env: "all", ...(runtimeEnabled ? { runtime: "all" as const } : {}), readOnly: resolved.readOnly } },
    defaults: { profile: id },
  };
}

async function untracked(source: string): Promise<string[]> {
  return nul(await requireGit(source, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .filter((file) => !file.split("/").includes(".boot"));
}

async function dirtySignature(source: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await requireGit(source, ["rev-parse", "HEAD"]));
  hash.update(await requireGit(source, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]));
  hash.update(await requireGit(source, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]));
  for (const file of await untracked(source)) {
    if (excludedSnapshotPath(file)) throw new Error(`Working-tree snapshot excludes credential or Boot path: ${file}`);
    const stat = await fs.lstat(resolveWithinRoot(source, file), { bigint: true });
    hash.update(`${file}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
  }
  return hash.digest("hex");
}

async function prepareSeed(record: SessionRecord, repository: SessionRepository, includes: Array<{ path: string; fingerprint: string }>): Promise<void> {
  const snapshot = repository.snapshot ?? repository.base;
  const target = seedPath(record, repository);
  const container = path.dirname(target);
  const complete = await readJson(path.join(container, "seed.json"));
  if (complete) {
    if (JSON.stringify(complete) !== JSON.stringify({ schemaVersion: 1, key: repository.seed, base: snapshot, owner: record.owner })) throw new Error("Seed ownership or identity mismatch.");
    return;
  }
  // A seed is created only in this attempt's private directory and published
  // by rename. No session uses a partially populated seed.
  const temporary = resolveWithinRoot(record.store, `seeds/attempt-${record.id}-${repository.id}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  await writeFileAtomic(path.join(temporary, "attempt.json"), JSON.stringify({ session: record.id, owner: record.owner }), { mode: 0o600 });
  const clone = path.join(temporary, "repository");
  try {
    await requireGit(temporary, ["clone", "--no-local", "--no-checkout", "--", repository.source, clone]);
    // --no-local deliberately avoids hard links and object alternates.
    for (const ref of lines(await requireGit(clone, ["for-each-ref", "--format=%(refname)"]))) await requireGit(clone, ["update-ref", "-d", ref]);
    await requireGit(clone, ["update-ref", "refs/heads/boot-seed", snapshot]);
    await requireGit(clone, ["reflog", "expire", "--expire=all", "--all"]);
    // Never carry plaintext credential files or external links
    // into an allegedly independent checkout.
    const entries = nul(await requireGit(clone, ["ls-tree", "-r", "-z", snapshot]));
    for (const entry of entries) {
      const file = entry.slice(entry.indexOf("\t") + 1);
      if (excludedSnapshotPath(file)) throw new Error(`Committed snapshot contains an excluded credential or Boot path: ${file}`);
    }
    await requireGit(clone, ["checkout", "--detach", snapshot]);
    for (const include of includes) {
      const source = resolveWithinRoot(repository.source, include.path);
      if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/i.test(include.path)) throw new Error("Live database files are not supported prepared artifacts.");
      const destination = resolveWithinRoot(clone, include.path);
      try { await fs.lstat(destination); throw new Error("Prepared include overlaps committed content."); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await copyTree(source, destination, true);
      if (await treeFingerprint(source) !== include.fingerprint) throw new Error("Prepared files changed during snapshot creation; stop writers and retry.");
    }
    // Validate relocatability, including tracked symlinks, after assembling the
    // complete tree. .git is a newly created standalone Git directory.
    await treeFingerprint(clone);
    await fs.writeFile(path.join(temporary, "seed.json"), JSON.stringify({ schemaVersion: 1, key: repository.seed, base: snapshot, owner: record.owner }), { mode: 0o600 });
    await fs.rm(path.join(temporary, "attempt.json"));
    await fs.rename(temporary, container);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function importWorkingTree(record: SessionRecord, repo: SessionRepository): Promise<void> {
  const destination = sessionRepoPath(record, repo);
  const before = await dirtySignature(repo.source);
  const staged = await requireGit(repo.source, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]);
  const unstaged = await requireGit(repo.source, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]);
  const files = await untracked(repo.source);
  const changed = await changedPaths(repo.source);
  if (changed.some(excludedSnapshotPath)) throw new Error("Working-tree changes include excluded credential or Boot paths.");
  if (staged) await requireGit(destination, ["apply", "--index", "--binary", "-"], `${staged}\n`);
  if (unstaged) await requireGit(destination, ["apply", "--binary", "-"], `${unstaged}\n`);
  for (const file of files) {
    if (repo.includes.some((include) => file === include.path || file.startsWith(`${include.path}/`))) continue;
    const target = resolveWithinRoot(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await copyTree(resolveWithinRoot(repo.source, file), target, ["apfs-clone", "linux-reflink", "refs-clone"].includes(repo.backend), { snapshotRoot: repo.source });
  }
  if (before !== await dirtySignature(repo.source)) throw new Error("Working-tree state changed during creation; stop writers and retry.");
  // Imported patches may add or replace tracked symlinks after seed validation.
  await treeFingerprint(destination);
  repo.importedChanges = Boolean(staged || unstaged || files.length || (repo.snapshot ?? repo.base) !== repo.base);
}

export async function createSession(sourceInput: string, options: CreateSessionOptions = {}): Promise<SessionRecord> {
  const sourceRoot = await fs.realpath(sourceInput);
  const definition = await loadWorkspaceDefinition(sourceRoot);
  const profile = options.profile ?? (definition.profiles?.agent ? "agent" : undefined);
  const resolved = resolveWorkspace(definition, profile);
  if (resolved.repositories.length === 0) throw new Error("The selected profile contains no repositories.");
  if (resolved.readOnly) throw new Error("Session creation requires a writable profile; readOnly is an agent intent, not enforced filesystem isolation.");
  if (options.runtime && !Object.keys(resolved.runtime ?? {}).length) throw new Error("--runtime requires resources declared in boot.yaml and selected by the active profile.");
  const storage = options.storage ?? "auto";
  if (!["auto", "cow", "worktree", "clone"].includes(storage)) throw new Error("Storage must be auto, cow, worktree, or clone.");
  if (options.include?.length && (storage === "worktree" || storage === "clone")) throw new Error("Prepared includes require --storage cow or auto; this policy never silently omits requested artifacts.");
  const name = options.name ?? `session-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Error("Session names must use 1–80 letters, digits, dots, underscores, or hyphens.");
  const paths = resolved.repositories.map((repo) => repo.path);
  if (paths.some((a, i) => paths.some((b, j) => i !== j && (a === "." || b.startsWith(`${a}/`) || a === b)))) throw new Error("Overlapping or nested selected repositories are not supported in managed sessions.");
  // Validate source containment before creating the default store.
  for (const repo of resolved.repositories) resolveWorkspaceRepositoryPath(sourceRoot, repo.path);
  const defaultStore = resolveWithinRoot(sourceRoot, ".boot/sessions");
  const store = await ensureStore(options.store ? path.resolve(options.store) : defaultStore);
  return withStoreLock(store, async () => {
    if ((await listSessionRecords(store)).some((session) => session.name === name)) throw new Error("A session with that name already exists in this store.");
    const id = randomUUID();
    const container = resolveWithinRoot(store, `sessions/${id}`);
    await fs.mkdir(container, { mode: 0o700 });
    const record: SessionRecord = {
      schemaVersion: 1, id, name, owner: sessionOwner(), store, root: path.join(container, "workspace"), sourceRoot,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "provisioning",
      definition: frozenDefinition(definition, profile, options.runtime), includeWorkingTree: options.includeWorkingTree ?? false,
      repositories: [], launch: null, externalOwner: null, lastExit: null, failure: null,
    };
    await fs.writeFile(path.join(container, "owner.json"), JSON.stringify({ id, owner: record.owner }), { mode: 0o600 });
    await writeSession(record);
    try {
      const includes = (options.include ?? []).map((input) => portableRelativePathSchema.parse(input));
      for (const include of includes) {
        if (excludedSnapshotPath(include) || include.split("/").includes(".git")) throw new Error("Prepared includes cannot contain Boot or credential state.");
        if (!paths.some((repo) => repo === "." || include.startsWith(`${repo}/`))) throw new Error(`Prepared include is outside selected repositories: ${include}`);
        if (includes.some((other) => other !== include && include.startsWith(`${other}/`))) throw new Error("Prepared includes overlap.");
      }
      const capability = storage === "clone" || storage === "worktree"
        ? { backend: null, reason: null } : await probeCow(path.join(store, "seeds"), container);
      if (storage === "cow" && !capability.backend) throw new Error(capability.reason!);
      if (includes.length && !capability.backend) throw new Error(`Requested prepared artifacts require CoW. ${capability.reason}`);
      const snapshots = await snapshotRepositories(sourceRoot, resolved.repositories, record.includeWorkingTree);
      if (includes.some((item) => snapshots.some((repo) => item === repo.path))) throw new Error("Prepared includes must be artifact paths inside a repository, not entire submodules.");
      for (const selected of snapshots) {
        const { source, base, snapshot } = selected;
        const sourceRef = await sessionGit(source, ["symbolic-ref", "--quiet", "HEAD"]);
        const relativeIncludes = includes.filter((item) => (selected.path === "." || item.startsWith(`${selected.path}/`))
          && !snapshots.some((other) => other.path !== selected.path && other.path.startsWith(selected.path === "." ? "" : `${selected.path}/`) && (item === other.path || item.startsWith(`${other.path}/`))))
          .map((item) => selected.path === "." ? item : item.slice(selected.path.length + 1));
        const prepared = [];
        for (const relative of relativeIncludes) {
          prepared.push({ path: relative, fingerprint: await treeFingerprint(resolveWithinRoot(source, relative)) });
        }
        const seed = createHash("sha256").update(JSON.stringify({ source, base: snapshot, prepared })).digest("hex");
        const repo: SessionRepository = {
          id: selected.id, relativePath: selected.path, source, base, sourceRef: sourceRef.exitCode === 0 ? sourceRef.stdout : null,
          ...(selected.submoduleOf ? { submoduleOf: selected.submoduleOf, gitlinkPath: selected.gitlinkPath, snapshot } : {}),
          seed, branch: `boot-sessions/${record.id}/${selected.id}`,
          backend: storage === "clone" ? "clone" : storage === "worktree" ? "worktree" : capability.backend ?? "worktree",
          fallbackReason: storage === "auto" ? capability.reason : null, importedChanges: false,
          excludedChanges: record.includeWorkingTree ? [] : [
            ...await changedPaths(source), ...await untracked(source),
          ].filter((file) => !relativeIncludes.some((include) => file === include || file.startsWith(`${include}/`))), includes: prepared,
        };
        record.repositories.push(repo);
        await writeSession(record); // journal the owned worktree path before registering it
        await prepareSeed(record, repo, prepared);
        const destination = sessionRepoPath(record, repo);
        if (repo.submoduleOf) {
          // Git creates an empty gitlink directory; remove only that empty
          // directory before creating the independently managed child checkout.
          await fs.rmdir(destination).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (["apfs-clone", "linux-reflink", "refs-clone"].includes(repo.backend)) {
          try {
            await copyTree(seedPath(record, repo), destination, true, { skipGit: true });
            await requireGit(destination, ["init"]);
            await fs.rm(path.join(destination, ".git", "objects"), { recursive: true });
            await copyTree(path.join(seedPath(record, repo), ".git", "objects"), path.join(destination, ".git", "objects"), true);
            await requireGit(destination, ["read-tree", snapshot]);
            await requireGit(destination, ["update-ref", "HEAD", snapshot]);
          } catch (error) {
            // Failures after the probe can be file-specific. Explicit CoW and
            // requested prepared content must never degrade to a full copy.
            if (storage !== "auto" || includes.length) throw error;
            await fs.rm(destination, { recursive: true, force: true });
            repo.backend = "worktree";
            repo.fallbackReason = `File cloning failed (${(error as NodeJS.ErrnoException).code ?? "unsupported file"}); using a managed Git worktree`;
          }
        }
        if (repo.backend === "worktree") {
          await writeSession(record);
          const result = await sessionGit(seedPath(record, repo), ["worktree", "add", "-b", repo.branch, destination, snapshot]);
          if (result.exitCode !== 0) {
            if (storage !== "auto") throw new Error("Managed Git worktree creation failed.");
            await sessionGit(seedPath(record, repo), ["worktree", "remove", "--force", destination]);
            await fs.rm(destination, { recursive: true, force: true });
            repo.backend = "clone";
            repo.fallbackReason = `${repo.fallbackReason ?? "CoW unavailable"}; Git worktree creation failed, using an ordinary clone`;
          }
        }
        if (repo.backend === "clone") {
          await writeSession(record);
          await requireGit(path.dirname(destination), ["clone", "--no-local", "--no-checkout", "--", seedPath(record, repo), destination]);
        }
        if (repo.backend !== "worktree") await requireGit(destination, ["checkout", "-b", repo.branch, snapshot]);
        // Session refs intentionally have no automatic upstream or push target.
        await requireGit(destination, ["config", "push.default", "nothing"]);
        const excludePath = path.resolve(destination, (await requireGit(destination, ["rev-parse", "--git-path", "info/exclude"])).trim());
        if (!isWithin(record.store, excludePath)) throw new Error("Session Git exclude path escaped the owned store.");
        const existingExclude = await fs.readFile(excludePath, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
        if (!existingExclude.split("\n").includes("/.boot/")) await writeFileAtomic(excludePath, `${existingExclude}\n/.boot/\n`);
        if (record.includeWorkingTree) await importWorkingTree(record, repo);
        for (const include of repo.includes) include.fingerprint = await treeFingerprint(resolveWithinRoot(destination, include.path));
        await writeSession(record);
      }
      if (record.includeWorkingTree) await importSubmoduleIndexes(record);
      const bootDir = path.join(record.root, ".boot");
      await fs.mkdir(bootDir, { mode: 0o700 });
      await writeFileAtomic(path.join(bootDir, "session.json"), JSON.stringify({ schemaVersion: 1, id: record.id, store: record.store }), { mode: 0o600 });
      await writeFileAtomic(path.join(bootDir, "session-definition.json"), JSON.stringify(record.definition), { mode: 0o600 });
      if (!paths.includes(".")) await fs.writeFile(path.join(record.root, "boot.yaml"), stringify(record.definition));
      if (options.runtime) await provisionRuntime(record, resolved.runtime!);
      record.state = "ready";
      await writeSession(record);
      return record;
    } catch (error) {
      record.state = "failed";
      // Known errors are actionable but never persist raw git/probe output.
      record.failure = error instanceof Error ? error.message : "Session provisioning failed";
      await writeSession(record);
      throw new Error(`Session ${record.id} failed: ${record.failure}. Its owned resources remain recoverable with boot session gc.`);
    }
  });
}

export interface RepositoryInspection {
  id: string; base: string; head: string | null; trackedChanges: string[]; untrackedFiles: string[];
  ignoredFiles: string[]; outstandingCommits: string[]; reasons: string[];
}

export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function activityReasons(record: SessionRecord): string[] {
  const reasons: string[] = [];
  if (record.externalOwner) reasons.push(`claimed by external agent ${record.externalOwner}`);
  if (record.launch && !record.launch.finished) {
    if (record.launch.pid && processExists(record.launch.group ? -record.launch.pid : record.launch.pid)) reasons.push("launched process or descendants are active");
    else if (processExists(record.launch.supervisor)) reasons.push("launcher is active");
    else reasons.push("interrupted launcher: process ownership is unverified; release with --acknowledge-stopped after checking external processes");
  }
  return reasons;
}

export async function inspectSession(selector: string, store?: string) {
  const record = await findSession(selector, store);
  const repositories: RepositoryInspection[] = [];
  for (const repo of record.repositories) {
    const result: RepositoryInspection = { id: repo.id, base: repo.base, head: null, trackedChanges: [], untrackedFiles: [], ignoredFiles: [], outstandingCommits: [], reasons: [] };
    try {
      const directory = sessionRepoPath(record, repo);
      result.head = (await requireGit(directory, ["rev-parse", "--verify", "HEAD"])).trim();
      result.trackedChanges = await changedPaths(directory);
      result.untrackedFiles = (await untracked(directory)).filter((file) => !repo.includes.some((include) => file === include.path || file.startsWith(`${include.path}/`)));
      result.ignoredFiles = nul(await requireGit(directory, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
        .filter((file) => !file.split("/").includes(".boot") && !repo.includes.some((include) => file === include.path || file.startsWith(`${include.path}/`)));
      // Worktree refs/reflogs are shared. Retaining additional work is safer
      // than accidentally dropping a commit on another branch or in a stash.
      result.outstandingCommits = lines(await requireGit(directory, ["rev-list", "--all", "--reflog", "HEAD", "--not", repo.base]));
      if (result.trackedChanges.length) result.reasons.push("tracked changes");
      if (result.untrackedFiles.length) result.reasons.push("untracked files");
      if (result.ignoredFiles.length) result.reasons.push("ignored files outside declared prepared artifacts");
      if (result.outstandingCommits.length) result.reasons.push("commits beyond the recorded base; publication and integration have not been verified");
      for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
        const gitPath = (await requireGit(directory, ["rev-parse", "--git-path", operation])).trim();
        if (await fs.lstat(path.resolve(directory, gitPath)).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) result.reasons.push(`Git operation in progress: ${operation}`);
      }
      if (repo.importedChanges) result.reasons.push("working-tree changes captured at creation");
      const sourceRefs = await requireGit(repo.source, ["for-each-ref", `--contains=${repo.base}`, "--format=%(refname)"]);
      if (!sourceRefs.trim()) result.reasons.push("base commit has no verified retained source ref");
      for (const include of repo.includes) {
        if (await treeFingerprint(resolveWithinRoot(directory, include.path)) !== include.fingerprint) result.reasons.push(`prepared artifact changed: ${include.path}`);
      }
    } catch {
      result.reasons.push("repository or snapshot state cannot be verified");
    }
    repositories.push(result);
  }
  const workspaceChanges: string[] = [];
  if (!record.repositories.some((repo) => repo.relativePath === ".")) {
    // Files created alongside selected repositories still belong to the user.
    // Traverse only repository ancestors; never follow links or enter repos.
    const visit = async (directory: string, relative = ""): Promise<void> => {
      for (const entry of await fs.readdir(directory)) {
        const item = relative ? `${relative}/${entry}` : entry;
        if (item === ".boot" || record.repositories.some((repo) => repo.relativePath === item)) continue;
        const target = path.join(directory, entry);
        const stat = await fs.lstat(target);
        if (item === "boot.yaml" && stat.isFile() && await fs.readFile(target, "utf8") === stringify(record.definition)) continue;
        if (stat.isDirectory() && record.repositories.some((repo) => repo.relativePath.startsWith(`${item}/`))) await visit(target, item);
        else workspaceChanges.push(item);
      }
    };
    try { await visit(record.root); } catch { workspaceChanges.push("workspace contents cannot be verified"); }
  }
  const runtime = await inspectRuntime(record);
  const protection = [...activityReasons(record), ...(runtime?.protection ?? []), ...workspaceChanges.map((file) => `workspace file outside repositories: ${file}`), ...repositories.flatMap((repo) => repo.reasons.map((reason) => `${repo.id}: ${reason}`))];
  if (record.state !== "released") protection.unshift(`session is ${record.state}; release it before cleanup`);
  return { schemaVersion: 1 as const, session: record, repositories, workspaceChanges, ...(runtime ? { runtime } : {}), protection, eligible: protection.length === 0 };
}

export async function releaseSession(selector: string, options: { store?: string; owner?: string; acknowledgeStopped?: boolean } = {}): Promise<SessionRecord> {
  const selected = await findSession(selector, options.store);
  return withStoreLock(selected.store, async () => {
    const record = await findSession(selected.id, selected.store);
    if (record.externalOwner) {
      if (options.owner !== record.externalOwner) throw new Error("An external agent owns this session; release requires its exact --owner label after the agent stops.");
      record.externalOwner = null;
    }
    if (record.launch && !record.launch.finished) {
      if ((record.launch.pid && processExists(record.launch.group ? -record.launch.pid : record.launch.pid)) || processExists(record.launch.supervisor)) throw new Error("Cannot release a session with active processes.");
      if (!options.acknowledgeStopped) throw new Error("Interrupted launch requires --acknowledge-stopped after verifying that all external processes stopped.");
      record.launch.finished = true;
    }
    if (record.state === "provisioning" || record.state === "failed" || record.state === "deleting") throw new Error("Use boot session gc to recover interrupted provisioning or removal.");
    await stopRuntime(record);
    record.state = "released";
    await writeSession(record);
    return record;
  });
}

export async function claimSession(selector: string, owner: string, store?: string): Promise<SessionRecord> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(owner)) throw new Error("Owner must be a short nonsecret identifier.");
  const selected = await findSession(selector, store);
  return withStoreLock(selected.store, async () => {
    const record = await findSession(selected.id, selected.store);
    if (!["ready", "released"].includes(record.state) || activityReasons(record).length) throw new Error("Session is already active or not ready.");
    record.externalOwner = owner;
    record.state = "running";
    await writeSession(record);
    return record;
  });
}

export async function sessionDiff(selector: string, store?: string): Promise<string> {
  const inspection = await inspectSession(selector, store);
  const parts: string[] = [];
  for (const repo of inspection.session.repositories) {
    parts.push(`Repository ${repo.id}; base ${repo.base}`);
    parts.push(await requireGit(sessionRepoPath(inspection.session, repo), ["diff", "--no-ext-diff", "--no-textconv", repo.base, "--"]));
    parts.push("Staged changes (index against HEAD):");
    parts.push(await requireGit(sessionRepoPath(inspection.session, repo), ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"]));
    const state = inspection.repositories.find((item) => item.id === repo.id)!;
    parts.push(`Untracked files: ${JSON.stringify(state.untrackedFiles)}`);
    parts.push(`Outstanding commits: ${state.outstandingCommits.join(", ") || "none"}`);
  }
  parts.push(`Workspace files outside repositories: ${JSON.stringify(inspection.workspaceChanges)}`);
  return parts.join("\n");
}

export async function gcSessions(options: { store?: string; apply?: boolean; session?: string; discardWork?: string } = {}) {
  const records = await listSessionRecords(options.store);
  if (options.discardWork && (!options.session || options.discardWork !== options.session || !/^[0-9a-f-]{36}$/.test(options.discardWork))) throw new Error("Destructive override requires --session <full-id> --discard-work <same-full-id>.");
  const candidates = options.session ? records.filter((record) => record.id === options.session || record.name === options.session) : records;
  if (options.session && candidates.length !== 1) throw new Error("Select exactly one session using its full ID.");
  const results: Array<{ id: string; name: string; action: string; reasons: string[]; runtime?: { ports: number[]; databases: Array<{ id: string; container: string; volume: string }>; network: string | null } }> = [];
  for (const candidate of candidates) {
    const assess = async () => {
      const inspection = await inspectSession(candidate.id, candidate.store);
      const record = inspection.session;
      const workspaceMissing = await fs.lstat(record.root).then(() => false, (error) => { if (error.code === "ENOENT") return true; throw error; });
      const interrupted = ["provisioning", "failed", "deleting"].includes(record.state) && workspaceMissing && !record.launch && !record.externalOwner;
      const discard = options.discardWork === record.id && ["released", "failed", "provisioning", "deleting"].includes(record.state);
      const runtimeReasons = await runtimeCleanupReasons(record);
      const allowed = runtimeReasons.length === 0 && activityReasons(record).length === 0 && (inspection.eligible || interrupted || discard);
      const item = { id: record.id, name: record.name,
        ...(record.runtime ? { runtime: { ports: record.runtime.ports.map((item) => item.port), databases: record.runtime.databases.map(({ id, container, volume }) => ({ id, container, volume })), network: record.runtime.network } } : {}),
        action: allowed ? options.apply ? "removed" : "would-remove" : "retained", reasons: allowed ? interrupted ? ["recovering owned resources from an interrupted operation"] : discard ? ["explicit session-scoped discard"] : [] : [...inspection.protection, ...runtimeReasons] };
      if (options.apply && allowed) {
        await verifyRecord(record);
        const recoveringRuntime = ["provisioning", "failed", "deleting"].includes(record.state);
        record.state = "deleting";
        await writeSession(record);
        await removeRuntime(record, recoveringRuntime);
        for (const repo of [...record.repositories].reverse()) {
          if (repo.backend === "worktree" && await fs.lstat(seedPath(record, repo)).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) {
            const target = sessionRepoPath(record, repo);
            // Validate before Git is allowed to recursively remove the path.
            resolveWithinRoot(record.store, toPosix(path.relative(record.store, target)));
            const removed = await sessionGit(seedPath(record, repo), ["worktree", "remove", "--force", target]);
            if (removed.exitCode !== 0) {
              const present = await fs.lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
              if (present) throw new Error("Worktree removal failed; session remains recoverable.");
              await requireGit(seedPath(record, repo), ["worktree", "prune"]);
            }
            await sessionGit(seedPath(record, repo), ["update-ref", "-d", `refs/heads/${repo.branch}`]);
          }
        }
        // Reclaim unused seeds as part of the same lock. Referenced seeds stay.
        // Keep the deletion journal until all resources have been reclaimed.
        const remaining = (await listSessionRecords(record.store)).filter((session) => session.id !== record.id);
        const used = new Set(remaining.flatMap((session) => session.repositories.map((repo) => repo.seed)));
        for (const repo of record.repositories) {
          if (!used.has(repo.seed)) {
            const seed = path.dirname(seedPath(record, repo));
            const marker = await readJson(path.join(seed, "seed.json"));
            if (marker && JSON.stringify(marker) === JSON.stringify({ schemaVersion: 1, key: repo.seed, base: repo.snapshot ?? repo.base, owner: record.owner })) await fs.rm(seed, { recursive: true });
          }
          const attempt = resolveWithinRoot(record.store, `seeds/attempt-${record.id}-${repo.id}`);
          const marker = await readJson(path.join(attempt, "attempt.json"));
          if (marker && JSON.stringify(marker) === JSON.stringify({ session: record.id, owner: record.owner })) await fs.rm(attempt, { recursive: true });
        }
        await fs.rm(resolveWithinRoot(record.store, `sessions/${record.id}`), { recursive: true });
      }
      return item;
    };
    results.push(options.apply ? await withStoreLock(candidate.store, assess) : await assess());
  }
  return { schemaVersion: 1 as const, dryRun: !options.apply, sessions: results };
}
