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

function resolveSetupShell(option: string | undefined): SupportedShell | null {
  if (option) {
    if (!isSupportedShell(option)) {
      throw new Error(`Unsupported shell "${option}". Supported: zsh, bash, fish.`);
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
  const block = `${needsLeadingNewline ? "\n" : ""}\n# boot on-access hydration\n${hookEvalLine(shell)}\n`;
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
  logger.heading(`boot setup — ${colors.cyan(root)}`);
  logger.info();

  // 1. Link, or pull if this workspace is already linked.
  logger.info(colors.bold("1. Map"));
  if (isLinked(root)) {
    if (remote) logger.info(colors.dim("   already linked — pulling latest (provided remote ignored)"));
    await pullCommand(root, { eager: options.eager });
  } else {
    if (!remote) {
      throw new Error(
        "This workspace isn't linked yet. Pass a map remote:\n" +
          "  boot setup <git-url> [path]        (or)\n" +
          "  boot setup --folder <dir> [path]",
      );
    }
    await linkCommand(remote, root, { eager: options.eager, folder: options.folder });
  }
  logger.info();

  // 2. Secret key for env-var sync.
  logger.info(colors.bold("2. Secret key"));
  await setupKey(root, options);
  logger.info();

  // 3. Shell hook (hydrate on cd).
  logger.info(colors.bold("3. Shell hook"));
  if (await offer("   Add the on-access shell hook to your shell rc?", options.hook, options.yes)) {
    await setupHook(options);
  } else {
    const shell = detectShell();
    const line = shell ? hookEvalLine(shell) : 'eval "$(boot shell-hook zsh)"';
    logger.info(colors.dim(`   skipped — add later with:  ${line}`));
  }
  logger.info();

  // 4. Managed daemon (keeps the workspace fresh, starts on boot).
  logger.info(colors.bold("4. Background daemon"));
  if (await offer("   Install the background sync daemon as a managed service?", options.daemon, options.yes)) {
    await daemonInstall(root, {
      intervalSeconds: options.interval,
      platform: options.platform ?? undefined,
      home: options.home,
      runner: options.serviceRunner,
      entry: options.entry,
    });
  } else {
    logger.info(colors.dim("   skipped — start it later with:  boot daemon install"));
  }
  logger.info();

  // 5. On-read mount (optional, advisory — it's a foreground process).
  logger.info(colors.bold("5. On-read mount (optional)"));
  setupMountHint(root, options);
  logger.info();

  // Summary.
  const health = await collectHealth(root, { home: options.home, platform: options.platform });
  renderSetupHealth(health);
  logger.info();
  logger.success("Setup complete.");
  if (health.hookInstalled) {
    logger.info(colors.dim("Restart your shell (or `source` your rc) to activate on-access hydration."));
  }
  logger.info(colors.dim("Re-check anytime with:  boot doctor --system"));
}

async function setupKey(root: string, options: SetupOptions): Promise<void> {
  if (keyExists()) {
    logger.success("secret key already present");
    return;
  }
  if (options.key === false) {
    logger.info(colors.dim("   skipped (--no-key)"));
    return;
  }
  if (options.importKey) {
    await envKeyImport(options.importKey);
    return;
  }

  const mapDir = mapPaths(root).mapDir;

  // Preferred path: the map escrows a passphrase-wrapped key. Unlock it instead
  // of hand-copying the raw key from another machine.
  if (await hasKeyringEntry(mapDir)) {
    logger.info(colors.dim("   this map has a passphrase-protected key (via `boot env key share`)."));
    if (isInteractive() && !options.yes) {
      if (await confirm("   Unlock it now with the passphrase?", { default: true })) {
        try {
          await envKeyReceive({ cwd: root });
          return;
        } catch (err) {
          logger.error(`   ${(err as Error).message}`);
        }
      }
    }
    logger.info(colors.dim("   skipped — unlock later with:  boot env key receive"));
    return;
  }

  // If the map already holds encrypted secrets, this machine needs the *existing*
  // key — creating a fresh one would just fail to decrypt them.
  const scopes = await listScopes(mapDir);
  if (scopes.length > 0) {
    logger.warn(`this map has ${scopes.length} encrypted env scope(s) but no key on this machine.`);
    if (isInteractive() && !options.yes) {
      const key = (await input("   Paste a key from `boot env key export` (or leave blank to skip):")).trim();
      if (key) {
        await envKeyImport(key);
        return;
      }
    }
    logger.info(colors.dim("   skipped — import it with:  boot env key import <key>"));
    return;
  }

  // First machine: a fresh key is the right call.
  if (options.yes || !isInteractive() || (await confirm("   Create a secret key for env-var sync?", { default: true }))) {
    await envInit();
  } else {
    logger.info(colors.dim("   skipped — create later with:  boot env init"));
  }
}

async function setupHook(options: SetupOptions): Promise<void> {
  const shell = resolveSetupShell(options.shell);
  if (!shell) {
    logger.warn("could not detect your shell; add it manually:");
    logger.info(colors.dim('   eval "$(boot shell-hook zsh)"   # or bash | fish'));
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
    logger.info(colors.dim(`   FUSE available — mount with:  boot mount ${root} ${mnt}`));
  } else {
    logger.info(
      colors.dim("   FUSE not installed (optional). Shell hook + `boot watch` already cover hydration."),
    );
  }
}
