import { launchWindowsSession, windowsCommand, windowsHelperPath, sessionEnvironment, type WindowsLaunch } from "./sessionWindows";
import { startRuntime } from "./sessionRuntime";
import { spawn } from "node:child_process";
import { readEnvScope } from "./env";
import { isLinked, mapPaths } from "./map";
import { keyExists, loadKey } from "./secrets";
import { resolveWorkspace } from "./workspace";
import { activityReasons, processExists } from "./sessions";
import { findSession, withStoreLock, writeSession, type SessionRecord } from "./sessionStore";

async function selectedEnvironment(record: SessionRecord): Promise<Record<string, string>> {
  const workspace = resolveWorkspace(record.definition);
  const selected: Record<string, string> = {};
  const required = workspace.env.filter((item) => item.source === "boot" && process.env[item.name] === undefined);
  if (!required.length) return selected;
  if (!isLinked(record.sourceRoot) || !keyExists()) throw new Error("Selected Boot environment values are unavailable; provision the source workspace's existing Boot key and encrypted values first.");
  const key = await loadKey();
  const map = mapPaths(record.sourceRoot).mapDir;
  const scopes = [await readEnvScope(map, { type: "global" }, key)];
  for (const repo of workspace.repositories) {
    if (repo.path !== ".") scopes.push(await readEnvScope(map, { type: "repo", relativePath: repo.path }, key));
  }
  for (const item of required) {
    const values = new Set(scopes.map((scope) => scope?.[item.name]).filter((value): value is string => value !== undefined));
    if (values.size !== 1) throw new Error(`Selected variable ${item.name} is missing or differs across repositories; a root launch requires one unambiguous value.`);
    selected[item.name] = [...values][0]!;
  }
  return selected;
}

export interface SessionExit { code: number | null; signal: NodeJS.Signals | null }

/** Direct executable + argv spawning; never join an agent command into a shell. */
export async function runSession(selector: string, argv: string[], options: { store?: string; stdio?: "inherit" | "ignore" } = {}): Promise<SessionExit> {
  if (!argv.length || !argv[0]) throw new Error("Provide an executable after --.");
  const selected = await findSession(selector, options.store);
  const env = await selectedEnvironment(selected);
  let child: ReturnType<typeof spawn>;
  let windowsLaunch: WindowsLaunch | undefined;
  let completion!: Promise<SessionExit>;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let pid: number | undefined;
  const group = process.platform !== "win32";
  let pendingSignal: NodeJS.Signals | null = null;
  const forward = (signal: NodeJS.Signals) => {
    if (windowsLaunch) { windowsLaunch.signal(signal); return; }
    if (!pid) { pendingSignal = signal; return; }
    try { process.kill(group ? -pid : pid, signal); } catch { /* Already exited. */ }
  };
  try {
    const record = await withStoreLock(selected.store, async () => {
      const record = await findSession(selected.id, selected.store);
      if (!["ready", "released"].includes(record.state) || activityReasons(record).length) throw new Error("Session is active or not ready to run.");
      const runtimeEnv = await startRuntime(record);
      const childEnv = sessionEnvironment(process.env, env, runtimeEnv, { BOOT_SESSION_ID: record.id, BOOT_SESSION_ROOT: record.root, BOOT_SESSION_STORE: record.store, BOOT_SESSION_SOURCE: record.sourceRoot });
      const command = process.platform === "win32" ? await windowsCommand(argv, record.root, childEnv) : argv;
      const windowsHelper = process.platform === "win32" ? await windowsHelperPath() : null;
      record.state = "running";
      // Persist a reservation first. A crash in the spawn/metadata window stays
      // unverified and protected, even if a child PID was never recorded.
      record.launch = { supervisor: process.pid, pid: null, group: process.platform !== "win32", startedAt: new Date().toISOString(), finished: false };
      // Install before any child can run. Signals during the reservation write
      // are forwarded immediately after spawn, before the PID write completes.
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
        const handler = () => forward(signal);
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
      await writeSession(record);
      if (windowsHelper) {
        windowsLaunch = await launchWindowsSession(windowsHelper, command, record.root, childEnv, options.stdio ?? "inherit");
        child = windowsLaunch.child;
        completion = windowsLaunch.completion;
      } else {
        child = spawn(command[0]!, command.slice(1), {
          cwd: record.root, shell: false, stdio: options.stdio ?? "inherit", detached: record.launch.group, env: childEnv,
        });
        // Listen immediately; short commands may exit during the metadata write.
        completion = new Promise<SessionExit>((resolve) => {
          child.once("error", () => resolve({ code: 127, signal: null }));
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
      }
      record.launch.pid = child.pid ?? null;
      pid = child.pid;
      if (pendingSignal) forward(pendingSignal);
      await writeSession(record);
      windowsLaunch?.start(); // The helper cannot create a child before its PID is journaled.
      return record;
    });
    const exit = await completion!;
    await withStoreLock(record.store, async () => {
      const current = await findSession(record.id, record.store);
      current.lastExit = exit;
      const descendants = current.launch?.group && current.launch.pid && processExists(-current.launch.pid);
      if (!descendants && (!windowsLaunch || windowsLaunch.completed())) {
        current.launch!.finished = true;
        current.state = "ready";
      }
      await writeSession(current);
    });
    return exit;
  } finally {
    windowsLaunch?.dispose();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}
