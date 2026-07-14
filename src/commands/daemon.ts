import path from "node:path";
import { loadConfig } from "../core/config";
import {
  clearDaemonPid,
  isDaemonRunning,
  readDaemonState,
  writeDaemonState,
  type TickSummary,
} from "../core/daemonState";
import { existsSync } from "node:fs";
import { syncOnce, type SyncOptions } from "../core/engine";
import { isLinked } from "../core/map";
import { detectServicePlatform, serviceFilePath } from "../core/service";
import { colors, logger } from "../ui/logger";

export interface DaemonStartOptions extends SyncOptions {
  /** Run a single sync and exit (great for cron / CI / tests). */
  once?: boolean;
  /** Override the sync interval, in seconds. */
  interval?: number;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensureLinked(root: string): void {
  if (!isLinked(root)) {
    throw new Error(
      `This workspace is not linked. Link it with: boot link <map-remote> ${commandArg(root)}`,
    );
  }
}

function describeTick(summary: TickSummary): string {
  if (!summary.ok) return colors.red(`sync failed: ${summary.error ?? "unknown error"}`);
  const parts = [
    `${summary.repoCount} ${summary.repoCount === 1 ? "repository" : "repositories"}`,
  ];
  if (summary.placeholders > 0) {
    parts.push(
      `+${summary.placeholders} ${
        summary.placeholders === 1 ? "placeholder" : "placeholders"
      }`,
    );
  }
  if (summary.cloned > 0) parts.push(`+${summary.cloned} cloned`);
  if (summary.updated > 0) parts.push(colors.green(`${summary.updated} updated`));
  if (summary.behind > 0) parts.push(colors.yellow(`${summary.behind} behind`));
  if (summary.diverged > 0) parts.push(colors.yellow(`${summary.diverged} diverged`));
  if (summary.dirty > 0) parts.push(`${summary.dirty} dirty`);
  if (summary.fetchFailed > 0) {
    parts.push(
      colors.yellow(
        `${summary.fetchFailed} ${summary.fetchFailed === 1 ? "fetch" : "fetches"} failed`,
      ),
    );
  }
  return parts.join(", ");
}

/** Run one sync tick, record it in the daemon state file, and log a summary line. */
async function runTickAndRecord(root: string, options: SyncOptions): Promise<TickSummary> {
  const at = new Date().toISOString();
  let summary: TickSummary;
  try {
    const result = await syncOnce(root, options);
    summary = {
      ok: true,
      at,
      repoCount: result.repoCount,
      placeholders: result.reconciled.placeholders,
      cloned: result.reconciled.cloned,
      pushed: result.pushed,
      updated: result.freshness.counts.updated,
      behind: result.freshness.counts.behind,
      diverged: result.freshness.counts.diverged,
      dirty: result.freshness.counts.dirty,
      fetchFailed: result.freshness.counts["fetch-failed"],
    };
  } catch (err) {
    summary = {
      ok: false,
      at,
      repoCount: 0,
      placeholders: 0,
      cloned: 0,
      pushed: false,
      updated: 0,
      behind: 0,
      diverged: 0,
      dirty: 0,
      fetchFailed: 0,
      error: (err as Error).message,
    };
  }

  const state = await readDaemonState(root);
  if (state) {
    await writeDaemonState(root, { ...state, lastTickAt: at, lastTick: summary });
  }

  if (summary.ok) logger.success(describeTick(summary));
  else logger.error(describeTick(summary));
  return summary;
}

function interruptibleSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 250;
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += step;
      if (shouldStop() || elapsed >= ms) {
        clearInterval(id);
        resolve();
      }
    }, step);
    // Don't let the timer keep the process alive on its own.
    if (typeof id.unref === "function") id.unref();
  });
}

export async function daemonStart(
  workspacePath = ".",
  options: DaemonStartOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  ensureLinked(root);

  const existing = await readDaemonState(root);
  if (isDaemonRunning(existing)) {
    throw new Error(
      `A boot daemon is already running for ${root} (pid ${existing?.pid}). Stop it with: boot daemon stop ${commandArg(root)}`,
    );
  }

  const config = await loadConfig(root);
  const intervalSeconds = options.interval ?? config.daemonIntervalSeconds;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("Daemon interval must be a positive whole number of seconds.");
  }
  const syncOptions: SyncOptions = {
    eager: options.eager,
    fetch: options.fetch,
    fastForward: options.fastForward,
  };

  if (options.once) {
    await writeDaemonState(root, {
      pid: null,
      startedAt: new Date().toISOString(),
      intervalSeconds,
      lastTickAt: null,
      lastTick: null,
    });
    logger.heading(`boot daemon — single sync of ${colors.cyan(root)}`);
    const summary = await runTickAndRecord(root, syncOptions);
    if (!summary.ok) {
      throw new Error(summary.error ?? "Daemon sync failed.");
    }
    return;
  }

  await writeDaemonState(root, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    intervalSeconds,
    lastTickAt: null,
    lastTick: null,
  });

  logger.heading(
    `boot daemon — watching ${colors.cyan(root)} every ${intervalSeconds}s (Ctrl-C to stop)`,
  );

  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
    logger.info(colors.dim("stopping…"));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    while (!stopping) {
      await runTickAndRecord(root, syncOptions);
      if (stopping) break;
      await interruptibleSleep(intervalSeconds * 1000, () => stopping);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await clearDaemonPid(root);
    logger.info("daemon stopped.");
  }
}

export async function daemonStop(workspacePath = "."): Promise<void> {
  const root = path.resolve(workspacePath);
  const state = await readDaemonState(root);

  if (!state || state.pid === null) {
    logger.info("No boot daemon is running for this workspace.");
    return;
  }

  if (!isDaemonRunning(state)) {
    await clearDaemonPid(root);
    logger.info("The daemon was not running. Cleared its saved status.");
    return;
  }

  try {
    process.kill(state.pid, "SIGTERM");
    logger.success(`Sent stop signal to daemon (pid ${state.pid}).`);
  } catch (err) {
    await clearDaemonPid(root);
    logger.warn(
      `Could not stop pid ${state.pid}: ${(err as Error).message}. Cleared its saved status.`,
    );
  }
}

export async function daemonStatus(workspacePath = "."): Promise<void> {
  const root = path.resolve(workspacePath);
  logger.heading(`boot daemon — ${colors.cyan(root)}`);

  const state = await readDaemonState(root);
  if (!state) {
    logger.info(colors.dim("never started for this workspace."));
    return;
  }

  const running = isDaemonRunning(state);
  logger.info(
    running
      ? `${colors.green("running")} (pid ${state.pid}, every ${state.intervalSeconds}s)`
      : colors.dim("not running"),
  );

  const platform = detectServicePlatform();
  if (platform) {
    const installed = existsSync(serviceFilePath(platform, root));
    logger.info(`Service: ${installed ? `${colors.green("installed")} (${platform})` : colors.dim("not installed")}`);
  }

  logger.info(`Started: ${state.startedAt}`);

  if (state.lastTick) {
    logger.info(`Last sync: ${state.lastTickAt}`);
    logger.info(`  ${describeTick(state.lastTick)}`);
  } else {
    logger.info(colors.dim("Last sync: never"));
  }
}
