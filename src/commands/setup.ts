import fs from "node:fs/promises";
import path from "node:path";
import {
  canLoadFuse,
  collectHealth,
  hookEvalLine,
  isSupportedShell,
  rcPathFor,
  detectShell,
  type SupportedShell,
} from "../core/health";
import { listScopes } from "../core/env";
import { hasKeyringEntry } from "../core/keyring";
import { isLinked, mapPaths } from "../core/map";
import { keyExists } from "../core/secrets";
import { type ServicePlatform } from "../core/service";
import { colors, logger } from "../ui/logger";
import { renderSetupHealth } from "../ui/health";
import { confirm, input, isInteractive } from "../ui/prompt";
import { envInit, envKeyImport, envKeyReceive } from "./env";
import { linkCommand } from "./link";
import { pullCommand } from "./pull";
import { daemonInstall, type ServiceRunner } from "./service";

export interface SetupOptions {
  /** Treat <remote> as an already-synced folder instead of a git URL. */
  folder?: boolean;
  /** Clone repos up front instead of writing placeholders. */
  eager?: boolean;
  /** Accept all prompts (non-interactive "do everything"). */
  yes?: boolean;
  /** `--no-hook` → skip the shell hook step (commander sets this false). */
  hook?: boolean;
  /** `--no-daemon` → skip installing the managed service. */
  daemon?: boolean;
  /** `--no-key` → skip secret-key setup. */
  key?: boolean;
  /** Install this base64 secret key (from `boot env key export` elsewhere). */
  importKey?: string;
  /** Override the shell for the hook step. */
  shell?: string;
  /** Daemon interval in seconds (passed to the managed service). */
  interval?: number;
  /** Suggest an on-read mountpoint in the summary. */
  mount?: string;
  /* ---- injection / testing ---- */
  home?: string;
  platform?: ServicePlatform | null;
  serviceRunner?: ServiceRunner;
  entry?: string;
}

/** Decide whether to run an optional step. `--no-X` skips; `--yes` does it; else ask (TTY only). */
async function offer(question: string, optValue: boolean | undefined, yes: boolean | undefined): Promise<boolean> {
  if (optValue === false) return false;
  if (yes) return true;
  if (!isInteractive()) return false;
  return confirm(question, { default: true });
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveSetupShell(option: string | undefined): SupportedShell | null {
  if (option) {
    if (!isSupportedShell(option)) {
      throw new Error(`Shell "${option}" is not supported. Use zsh, bash, fish, or powershell.`);
    }
    return option;
  }
  return detectShell();
}

/** Append the hook eval line to a shell rc file (idempotent). Returns whether it wrote. */
async function appendHookToRc(rcPath: string, shell: SupportedShell): Promise<boolean> {
  let existing = "";
  try {
    existing = await fs.readFile(rcPath, "utf8");
  } catch {
    // rc file doesn't exist yet — we'll create it.
  }
  if (existing.includes("boot shell-hook")) return false;
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  const block = `${needsLeadingNewline ? "\n" : ""}\n# boot: clone repository placeholders on access\n${hookEvalLine(shell)}\n`;
  await fs.mkdir(path.dirname(rcPath), { recursive: true });
  await fs.appendFile(rcPath, block, "utf8");
  return true;
}

/**
 * One-command onboarding: link (or pull) → secret key → shell hook → managed
 * daemon → on-read mount hint, then print a health summary. Interactive by
 * default; `--yes` (or any `--no-*` flag) makes it scriptable.
 */
export async function setupCommand(
  remote: string | undefined,
  workspacePath = ".",
  options: SetupOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  logger.heading(`Set up workspace — ${colors.cyan(root)}`);
  logger.info();

  // 1. Link, or pull if this workspace is already linked.
  logger.info(colors.bold("1. workspace map"));
  if (isLinked(root)) {
    if (remote) logger.info(colors.dim("   Already linked. Ignored the remote and pulled the latest map."));
    await pullCommand(root, { eager: options.eager });
  } else {
    if (!remote) {
      throw new Error(
        "This workspace is not linked. Run one of:\n" +
          `  boot link <map-remote> ${commandArg(root)}\n` +
          `  boot link <map-folder> ${commandArg(root)} --folder`,
      );
    }
    await linkCommand(remote, root, { eager: options.eager, folder: options.folder, yes: options.yes });
  }
  logger.info();

  // 2. Secret key for env-var sync.
  logger.info(colors.bold("2. Secret key"));
  await setupKey(root, options);
  logger.info();

  // 3. Shell hook (hydrate on cd).
  logger.info(colors.bold("3. Shell hook"));
  if (await offer("   Add automatic placeholder cloning to your shell?", options.hook, options.yes)) {
    await setupHook(options);
  } else {
    const shell = detectShell();
    if (shell) {
      logger.info(colors.dim(`   Skipped. Add it later with: ${hookEvalLine(shell)}`));
    } else {
      logger.info(
        colors.dim("   Skipped. Set it up later with: boot shell-hook --help"),
      );
    }
  }
  logger.info();

  // 4. Managed daemon (keeps the workspace fresh, starts on boot).
  logger.info(colors.bold("4. Background sync"));
  if (await offer("   Install the background sync daemon as a managed service?", options.daemon, options.yes)) {
    await daemonInstall(root, {
      intervalSeconds: options.interval,
      platform: options.platform ?? undefined,
      home: options.home,
      runner: options.serviceRunner,
      entry: options.entry,
    });
  } else {
    logger.info(
      colors.dim(`   Skipped. Install it later with: boot daemon install ${commandArg(root)}`),
    );
  }
  logger.info();

  // 5. On-read mount (optional, advisory — it's a foreground process).
  logger.info(colors.bold("5. Mount on read (optional)"));
  setupMountHint(root, options);
  logger.info();

  // Summary.
  const health = await collectHealth(root, { home: options.home, platform: options.platform });
  renderSetupHealth(health);
  logger.info();
  logger.success("Setup complete.");
  if (health.hookInstalled) {
    logger.info(colors.dim("Start a new shell to enable automatic placeholder cloning."));
  }
  logger.next(`Check setup again: boot doctor ${commandArg(root)} --system`);
}

async function setupKey(root: string, options: SetupOptions): Promise<void> {
  if (keyExists()) {
    logger.success("secret key already present");
    return;
  }
  if (options.key === false) {
    logger.info(colors.dim("   Skipped because --no-key was set."));
    return;
  }
  if (options.importKey) {
    await envKeyImport(options.importKey);
    return;
  }

  const mapDir = mapPaths(root).mapDir;

  // Preferred path: the map stores a passphrase-protected key. Install it
  // instead of hand-copying the raw key from another machine.
  if (await hasKeyringEntry(mapDir)) {
    logger.info(colors.dim("   The workspace map has a passphrase-protected key."));
    if (isInteractive() && !options.yes) {
      if (await confirm("   Install it now with the passphrase?", { default: true })) {
        try {
          await envKeyReceive({ cwd: root });
          return;
        } catch (err) {
          logger.error(`   ${(err as Error).message}`);
        }
      }
    }
    logger.info(
      colors.dim(`   Skipped. Install it later with: boot env key receive -C ${commandArg(root)}`),
    );
    return;
  }

  // If the map already holds encrypted secrets, this machine needs the *existing*
  // key — creating a fresh one would just fail to decrypt them.
  const scopes = await listScopes(mapDir);
  if (scopes.length > 0) {
    const sets = scopes.length === 1 ? "set" : "sets";
    logger.warn(
      `The workspace map has ${scopes.length} encrypted environment ${sets}, but this machine has no key.`,
    );
    if (isInteractive() && !options.yes) {
      const key = (await input("   Paste an exported key, or leave this blank to skip:")).trim();
      if (key) {
        await envKeyImport(key);
        return;
      }
    }
    logger.info(colors.dim("   Skipped. Import it later with: boot env key import"));
    return;
  }

  // First machine: a fresh key is the right call.
  if (options.yes || !isInteractive() || (await confirm("   Create a secret key for env-var sync?", { default: true }))) {
    await envInit();
  } else {
    logger.info(colors.dim("   Skipped. Create it later with: boot env init"));
  }
}

async function setupHook(options: SetupOptions): Promise<void> {
  const shell = resolveSetupShell(options.shell);
  if (!shell) {
    logger.warn("Could not detect your shell.");
    logger.info(colors.dim("   Choose your shell with: boot shell-hook --help"));
    return;
  }
  const rcPath = rcPathFor(shell, options.home);
  const wrote = await appendHookToRc(rcPath, shell);
  if (wrote) logger.success(`added the ${shell} hook to ${colors.cyan(rcPath)}`);
  else logger.info(`${colors.dim("\u2022")} hook already present in ${rcPath}`);
}

function setupMountHint(root: string, options: SetupOptions): void {
  if (canLoadFuse()) {
    const mnt = options.mount ?? `${root}-live`;
    logger.info(
      colors.dim(`   FUSE is available. Mount with: boot mount ${commandArg(root)} ${commandArg(mnt)}`),
    );
  } else {
    logger.info(
      colors.dim("   FUSE is optional and not installed. The shell hook and `boot watch` still clone placeholders."),
    );
  }
}
