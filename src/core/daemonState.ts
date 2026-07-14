import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { mapPaths } from "./map";
import { fileReadError, isFileNotFoundError, quoteUserValue } from "./userErrors";

/** Machine-local daemon state file (sibling of link.json, never synced). */
export const DAEMON_STATE_FILE = "daemon.json";

export const tickSummarySchema = z.object({
  ok: z.boolean(),
  at: z.string(),
  repoCount: z.number(),
  placeholders: z.number(),
  cloned: z.number(),
  pushed: z.boolean(),
  updated: z.number(),
  behind: z.number(),
  diverged: z.number(),
  dirty: z.number(),
  fetchFailed: z.number().default(0),
  error: z.string().optional(),
});

export type TickSummary = z.infer<typeof tickSummarySchema>;

export const daemonStateSchema = z.object({
  /** PID of the running loop, or null when not actively looping (e.g. after `--once`). */
  pid: z.number().nullable(),
  startedAt: z.string(),
  intervalSeconds: z.number(),
  lastTickAt: z.string().nullable(),
  lastTick: tickSummarySchema.nullable(),
});

export type DaemonState = z.infer<typeof daemonStateSchema>;

function statePath(root: string): string {
  return path.join(mapPaths(root).bootDir, DAEMON_STATE_FILE);
}

export async function readDaemonState(root: string): Promise<DaemonState | null> {
  const filePath = statePath(root);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw fileReadError("daemon state", filePath, error);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Daemon state at ${quoteUserValue(filePath, 500)} is not valid JSON. Delete the file, then start the daemon again.`,
    );
  }
  const parsed = daemonStateSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Daemon state at ${quoteUserValue(filePath, 500)} has an invalid format. Delete the file, then start the daemon again.`,
    );
  }
  return parsed.data;
}

export async function writeDaemonState(root: string, state: DaemonState): Promise<void> {
  const { bootDir } = mapPaths(root);
  await fs.mkdir(bootDir, { recursive: true });
  await fs.writeFile(statePath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearDaemonPid(root: string): Promise<void> {
  const state = await readDaemonState(root);
  if (state) await writeDaemonState(root, { ...state, pid: null });
}

/** Whether a process with the given pid is currently alive. */
export function pidAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the daemon loop is recorded as running and its process is alive. */
export function isDaemonRunning(state: DaemonState | null): boolean {
  return Boolean(state && state.pid !== null && pidAlive(state.pid));
}
