import { execaCommand } from "execa";
import {
  inspectService,
  type RequirementStatus,
} from "./requirements";
import { sanitizeUserText } from "./userErrors";
import type { ServiceDefinition } from "./workspace";

/** How long Boot waits for a started service to report healthy, by default. */
export const DEFAULT_READY_TIMEOUT_SECONDS = 90;

/** Ceiling for the start command itself (first-time image pulls can be slow). */
const START_COMMAND_TIMEOUT_MS = 600_000;

export interface ServiceStartEvent {
  service: string;
  phase: "starting" | "waiting" | "ready" | "failed" | "skipped";
  detail?: string;
}

export interface ServiceStartResult {
  name: string;
  action: "already-available" | "started" | "skipped" | "failed";
  /** The service's health status after this attempt. */
  status: RequirementStatus;
  detail?: string;
}

export interface StartServicesOptions {
  /** Progress callback so a UI can narrate long waits. Core never prints. */
  onEvent?: (event: ServiceStartEvent) => void;
  /** Poll interval override, primarily for testing. */
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startService(
  root: string,
  name: string,
  definition: ServiceDefinition,
  options: StartServicesOptions,
): Promise<ServiceStartResult> {
  const emit = options.onEvent ?? ((): void => {});
  const initial = await inspectService(name, definition, { cwd: root });

  if (initial.state === "available") {
    emit({ service: name, phase: "ready", detail: "already running" });
    return { name, action: "already-available", status: initial };
  }
  if (initial.state === "mismatch") {
    const detail =
      "the running service does not match the required version; Boot will not restart it";
    emit({ service: name, phase: "skipped", detail });
    return { name, action: "skipped", status: initial, detail };
  }
  if (initial.state === "unsupported") {
    // Schema validation prevents `start` without a health check; degrade safely.
    const detail = initial.detail ?? "no health check is available for this service";
    emit({ service: name, phase: "skipped", detail });
    return { name, action: "skipped", status: initial, detail };
  }
  if (!definition.start) {
    const detail = "not running, and boot.yaml declares no start command";
    emit({ service: name, phase: "skipped", detail });
    return { name, action: "skipped", status: initial, detail };
  }

  emit({ service: name, phase: "starting", detail: definition.start });
  const run = await execaCommand(definition.start, {
    cwd: root,
    shell: true,
    reject: false,
    timeout: START_COMMAND_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (run.timedOut) {
    const detail =
      "the start command did not exit within 10 minutes; use a form that returns " +
      "after launching (for example `docker compose up -d`)";
    emit({ service: name, phase: "failed", detail });
    return { name, action: "failed", status: initial, detail };
  }
  if (run.exitCode !== 0) {
    const output = sanitizeUserText(run.stderr || run.stdout);
    const detail = `the start command exited with status ${run.exitCode}${
      output ? `: ${output}` : ""
    }`;
    emit({ service: name, phase: "failed", detail });
    return { name, action: "failed", status: initial, detail };
  }

  const timeoutSeconds = definition.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1000;
  emit({ service: name, phase: "waiting" });
  for (;;) {
    const status = await inspectService(name, definition, { cwd: root });
    if (status.state === "available") {
      emit({ service: name, phase: "ready" });
      return { name, action: "started", status };
    }
    if (status.state === "mismatch" || status.state === "unsupported") {
      const detail =
        status.detail ??
        "the service started, but its running version could not satisfy the requirement";
      emit({ service: name, phase: "failed", detail });
      return { name, action: "failed", status, detail };
    }
    if (Date.now() >= deadline) {
      const detail =
        `the start command succeeded, but the service did not report healthy within ` +
        `${timeoutSeconds}s${status.detail ? `: ${status.detail}` : ""}`;
      emit({ service: name, phase: "failed", detail });
      return { name, action: "failed", status, detail };
    }
    await sleep(options.pollIntervalMs ?? 1_000);
  }
}

/**
 * Bring declared services up and verify their health. For each service, in
 * declaration order: if its health check already passes, do nothing; otherwise
 * run its declared `start` command and poll the check until it reports healthy
 * or the timeout elapses. Boot delegates *how* a service starts to the command
 * declared in boot.yaml — it never supervises processes.
 */
export async function startServices(
  root: string,
  services: Record<string, ServiceDefinition>,
  options: StartServicesOptions = {},
): Promise<ServiceStartResult[]> {
  const results: ServiceStartResult[] = [];
  for (const [name, definition] of Object.entries(services)) {
    results.push(await startService(root, name, definition, options));
  }
  return results;
}
