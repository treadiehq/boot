import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { isDaemonRunning, readDaemonState } from "./daemonState";
import { isLinked, readLinkConfig } from "./map";
import { keyExists, secretKeyPath } from "./secrets";
import { detectServicePlatform, serviceFilePath, type ServicePlatform } from "./service";

export type SupportedShell = "zsh" | "bash" | "fish";

export const SHELLS: SupportedShell[] = ["zsh", "bash", "fish"];

export function isSupportedShell(value: string): value is SupportedShell {
  return (SHELLS as string[]).includes(value);
}

/** Best-effort detection of the current shell from `$SHELL`. */
export function detectShell(): SupportedShell | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  const name = path.basename(shell);
  return isSupportedShell(name) ? name : null;
}

/** The rc file boot's shell hook belongs in for a given shell. */
export function rcPathFor(shell: SupportedShell, home: string = os.homedir()): string {
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") return path.join(home, ".bashrc");
  return path.join(home, ".config", "fish", "config.fish");
}

/** The one-liner that wires up the hook, per shell. */
export function hookEvalLine(shell: SupportedShell): string {
  return shell === "fish"
    ? "boot shell-hook fish | source"
    : `eval "$(boot shell-hook ${shell})"`;
}

/** Whether a shell rc file already sources boot's hook. */
export function hookInstalledIn(rcPath: string): boolean {
  try {
    return readFileSync(rcPath, "utf8").includes("boot shell-hook");
  } catch {
    return false;
  }
}

/** Whether the optional `fuse-native` binding can be resolved (without loading it). */
export function canLoadFuse(): boolean {
  try {
    createRequire(import.meta.url).resolve("fuse-native");
    return true;
  } catch {
    return false;
  }
}

export interface SetupHealth {
  root: string;
  linked: boolean;
  linkKind: "git" | "folder" | null;
  remote: string | null;
  keyPresent: boolean;
  keyPath: string;
  shell: SupportedShell | null;
  rcPath: string | null;
  hookInstalled: boolean;
  servicePlatform: ServicePlatform | null;
  serviceInstalled: boolean;
  daemonRunning: boolean;
  fuseAvailable: boolean;
}

export interface HealthOptions {
  /** Home dir override (for resolving rc + service file paths in tests). */
  home?: string;
  /** Service platform override (null = none). Defaults to auto-detect. */
  platform?: ServicePlatform | null;
}

/**
 * Snapshot of how completely boot is wired up on this machine for one workspace:
 * is it linked, is there a secret key, is the shell hook installed, is the daemon
 * running/installed, and is on-read mounting available. Pure data — the command
 * layer renders it.
 */
export async function collectHealth(root: string, opts: HealthOptions = {}): Promise<SetupHealth> {
  const home = opts.home ?? os.homedir();
  const linked = isLinked(root);
  const cfg = linked ? await readLinkConfig(root) : null;
  const platform = opts.platform === undefined ? detectServicePlatform() : opts.platform;
  const serviceInstalled = platform ? existsSync(serviceFilePath(platform, root, home)) : false;
  const state = await readDaemonState(root);
  const shell = detectShell();
  const rcPath = shell ? rcPathFor(shell, home) : null;

  return {
    root,
    linked,
    linkKind: cfg?.kind ?? null,
    remote: cfg?.remote ?? null,
    keyPresent: keyExists(),
    keyPath: secretKeyPath(),
    shell,
    rcPath,
    hookInstalled: rcPath ? hookInstalledIn(rcPath) : false,
    servicePlatform: platform,
    serviceInstalled,
    daemonRunning: isDaemonRunning(state),
    fuseAvailable: canLoadFuse(),
  };
}
