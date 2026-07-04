import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  daemonStart,
  daemonStatus,
  daemonStop,
  type DaemonStartOptions,
} from "./commands/daemon";
import { agentCommand, type AgentOptions } from "./commands/agent";
import { cdCommand, type CdOptions } from "./commands/cd";
import { doctorCommand, type DoctorOptions } from "./commands/doctor";
import { enterCommand } from "./commands/enter";
import {
  envImport,
  envInit,
  envKeyExport,
  envKeyImport,
  envKeyReceive,
  envKeyRevoke,
  envKeyShare,
  envList,
  envMaterialize,
  envRm,
  envSet,
} from "./commands/env";
import { hydrateCommand } from "./commands/hydrate";
import { initCommand, type InitOptions } from "./commands/init";
import { linkCommand, type LinkOptions } from "./commands/link";
import { listCommand } from "./commands/list";
import { mountCommand, unmountCommand } from "./commands/mount";
import { pullCommand, type PullOptions } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { restoreCommand, type RestoreOptions } from "./commands/restore";
import { scanCommand, type ScanOptions } from "./commands/scan";
import { daemonInstall, daemonUninstall } from "./commands/service";
import { setupCommand, type SetupOptions } from "./commands/setup";
import { shellHookCommand } from "./commands/shellHook";
import { statusCommand } from "./commands/status";
import { updateCommand, type UpdateOptions } from "./commands/update";
import { watchCommand } from "./commands/watch";
import { logger } from "./ui/logger";

export const DEFAULT_MANIFEST_NAME = "boot-workspace.json";

/**
 * Resolve the CLI version. Standalone release binaries get `__BOOT_VERSION__`
 * baked in at build time (there is no package.json on disk next to a compiled
 * binary); source and dev builds fall back to reading it from package.json.
 */
declare const __BOOT_VERSION__: string | undefined;
function resolveVersion(): string {
  if (typeof __BOOT_VERSION__ === "string" && __BOOT_VERSION__.length > 0) {
    return __BOOT_VERSION__;
  }
  try {
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    return version;
  } catch {
    return "0.0.0";
  }
}

const VERSION = resolveVersion();

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("boot")
    .description(
      "boot — Dropbox for ~/code. Sync your workspace structure across machines and hydrate repos on access.",
    )
    .version(VERSION, "-v, --version", "print boot's version and exit");

  program.commandsGroup("Getting started:");

  program
    .command("version")
    .description("print boot's version and exit")
    .action(() => logger.info(VERSION));

  program
    .command("setup")
    .description("one-command onboarding: link → key → shell hook → daemon → summary")
    .argument("[remote]", "git URL (or folder path with --folder); omit if already linked")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--folder", "treat <remote> as an already-synced folder, not a git URL", false)
    .option("--eager", "clone repos instead of writing placeholders", false)
    .option("-y, --yes", "accept all prompts (non-interactive)", false)
    .option("--no-hook", "skip installing the shell hook")
    .option("--no-daemon", "skip installing the managed daemon service")
    .option("--no-key", "skip secret-key setup")
    .option("--import-key <base64>", "install a secret key exported from another machine")
    .option("--shell <shell>", "shell for the hook (zsh|bash|fish|powershell; auto-detected otherwise)")
    .option("--interval <seconds>", "daemon sync interval", (v) => Number.parseInt(v, 10))
    .option("--mount <mountpoint>", "suggest this on-read mountpoint in the summary")
    .action((remote: string | undefined, workspacePath: string, options: SetupOptions) =>
      setupCommand(remote, workspacePath, options),
    );

  program
    .command("init")
    .description("create default .bootignore and boot.yaml in a workspace")
    .argument("<workspacePath>", "path to the developer workspace to initialise")
    .option("-f, --force", "overwrite existing files", false)
    .action((workspacePath: string, options: InitOptions) => initCommand(workspacePath, options));

  program
    .command("update")
    .description("update boot itself to the latest version")
    .option("--ref <ref>", "release tag (binary install) or git ref (source install) to update to")
    .action((options: UpdateOptions) => updateCommand(options));

  program.commandsGroup("Portable snapshot (offline, no remote):");

  program
    .command("export")
    .alias("scan")
    .description("save a portable snapshot of this workspace's git repos to a file")
    .argument("<workspacePath>", "path to the developer workspace to snapshot")
    .option("-o, --output <file>", "output snapshot path", DEFAULT_MANIFEST_NAME)
    .action((workspacePath: string, options: ScanOptions) => scanCommand(workspacePath, options));

  program
    .command("list")
    .description("print a summary table of the repos in a snapshot file")
    .argument("<manifestPath>", "path to a boot snapshot file")
    .action((manifestPath: string) => listCommand(manifestPath));

  program
    .command("import")
    .alias("restore")
    .description("recreate a workspace's folder structure and repos from a snapshot file")
    .argument("<manifestPath>", "path to a boot snapshot file")
    .argument("<targetPath>", "directory to recreate the workspace into")
    .option("--lazy", "create placeholders instead of cloning repos", false)
    .action((manifestPath: string, targetPath: string, options: RestoreOptions) =>
      restoreCommand(manifestPath, targetPath, options),
    );

  program.commandsGroup("On-access hydration:");

  program
    .command("hydrate")
    .description("clone a placeholder repo into its folder")
    .argument("<repoPath>", "path to a placeholder repo folder")
    .action((repoPath: string) => hydrateCommand(repoPath));

  program
    .command("enter")
    .description("hydrate the placeholder you just navigated into (on-access trigger)")
    .argument("[targetPath]", "directory you are entering", ".")
    .option("-q, --quiet", "print nothing (used by the shell hook)", false)
    .action((targetPath: string, options: { quiet?: boolean }) =>
      enterCommand(targetPath, { quiet: options.quiet }),
    );

  program
    .command("cd")
    .description("resolve a repo in your map (hydrating it), printing its path — pair with the `bcd` shell function")
    .argument("[query]", "fuzzy repo name or path; omit to browse interactively")
    .option("-C, --cwd <path>", "workspace directory (or anywhere inside it)", ".")
    .option("--print", "print only the resolved path to stdout (used by `bcd`)", false)
    .option("--json", "print the match as a JSON line to stdout", false)
    .action((query: string | undefined, options: CdOptions) => cdCommand(query ?? "", options));

  program
    .command("shell-hook")
    .description("print a shell snippet that hydrates placeholders when you cd into them (and defines `bcd`)")
    .argument("[shell]", "zsh, bash, fish, or powershell (auto-detected if omitted)")
    .action((shell?: string) => shellHookCommand(shell));

  program
    .command("watch")
    .description("watch a workspace and hydrate placeholders on first write activity")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--debounce <ms>", "milliseconds to wait after activity", (v) => Number.parseInt(v, 10))
    .action((workspacePath: string, options: { debounce?: number }) =>
      watchCommand(workspacePath, { debounce: options.debounce }),
    );

  program
    .command("mount")
    .description("mount a workspace as a virtual FS that hydrates files on first read (needs FUSE)")
    .argument("<workspacePath>", "workspace directory to expose")
    .argument("<mountpoint>", "directory to mount the virtual workspace at")
    .option("--read-only", "reads still hydrate, but writes fail (EROFS)", false)
    .option("--debug", "print FUSE operation traffic", false)
    .action((workspacePath: string, mountpoint: string, options: { debug?: boolean; readOnly?: boolean }) =>
      mountCommand(workspacePath, mountpoint, { debug: options.debug, readOnly: options.readOnly }),
    );

  program
    .command("unmount")
    .description("force-unmount a workspace mounted with `boot mount`")
    .argument("<mountpoint>", "the mountpoint to unmount")
    .action((mountpoint: string) => unmountCommand(mountpoint));

  program.commandsGroup("Inspect:");

  program
    .command("status")
    .description("show hydrated repos, placeholders, and other folders in a workspace")
    .argument("<workspacePath>", "path to the developer workspace to inspect")
    .action((workspacePath: string) => statusCommand(workspacePath));

  program
    .command("doctor")
    .description("scan a workspace and print health warnings")
    .argument("<workspacePath>", "path to the developer workspace to check")
    .option("--system", "check boot's own setup (link, key, hook, daemon, FUSE) instead of repos", false)
    .action((workspacePath: string, options: DoctorOptions) => doctorCommand(workspacePath, options));

  program.commandsGroup("Sync across machines:");

  program
    .command("link")
    .description("connect a workspace to a shared boot map and sync its structure")
    .argument("<remote>", "git URL of the map repo (or a folder path with --folder)")
    .argument("[workspacePath]", "workspace directory to link", ".")
    .option("--eager", "clone repos instead of writing placeholders", false)
    .option("--folder", "treat <remote> as an already-synced folder (Dropbox/Drive/…), not a git URL", false)
    .option("-y, --yes", "accept prompts (e.g. create a missing map remote via gh)", false)
    .action((remote: string, workspacePath: string, options: LinkOptions) =>
      linkCommand(remote, workspacePath, options),
    );

  program
    .command("push")
    .description("scan this workspace and publish its structure to the shared map")
    .argument("[workspacePath]", "workspace directory", ".")
    .action((workspacePath: string) => pushCommand(workspacePath));

  program
    .command("pull")
    .description("fetch the shared map and recreate any missing structure")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--eager", "clone repos instead of writing placeholders", false)
    .option("--dry-run", "show what would change without writing anything", false)
    .action((workspacePath: string, options: PullOptions) => pullCommand(workspacePath, options));

  program
    .command("agent")
    .description("one-shot, idempotent bootstrap for CI / cloud agents (link-or-pull + hydrate)")
    .argument("<remote>", "git URL of the map repo (or a folder path with --folder)")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--eager", "clone repos instead of writing placeholders", false)
    .option("--all", "hydrate every placeholder after setup", false)
    .option(
      "--hydrate <patterns...>",
      "hydrate placeholders whose relativePath matches these glob patterns",
    )
    .option("--env", "materialize env vars if a secret key is present", false)
    .option("--folder", "treat <remote> as an already-synced folder, not a git URL", false)
    .option("--dry-run", "show what would change without writing anything", false)
    .action((remote: string, workspacePath: string, options: AgentOptions) =>
      agentCommand(remote, workspacePath, options),
    );

  const env = program
    .command("env")
    .description("sync encrypted env vars across machines via the shared map");

  env
    .command("init")
    .description("create this machine's secret key (encrypts env vars in the map)")
    .action(() => envInit());

  env
    .command("set")
    .description("set one or more KEY=VALUE env vars")
    .argument("<assignments...>", "KEY=VALUE pairs")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--repo <relativePath>", "scope to a repo instead of the whole workspace")
    .action((assignments: string[], options: { cwd?: string; repo?: string }) =>
      envSet(assignments, options),
    );

  env
    .command("import")
    .description("merge a .env file into a scope")
    .argument("<file>", "path to a .env file")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--repo <relativePath>", "scope to a repo instead of the whole workspace")
    .action((file: string, options: { cwd?: string; repo?: string }) => envImport(file, options));

  env
    .command("list")
    .description("list stored env scopes and keys (values masked)")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .action((options: { cwd?: string }) => envList(options));

  env
    .command("rm")
    .description("remove env vars (or --all to clear a scope)")
    .argument("[keys...]", "key names to remove")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--repo <relativePath>", "scope to a repo instead of the whole workspace")
    .option("--all", "remove every var in the scope", false)
    .action((keys: string[], options: { cwd?: string; repo?: string; all?: boolean }) =>
      envRm(keys, options),
    );

  env
    .command("materialize")
    .description("write decrypted .env files into the workspace (git-excluded)")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .action((options: { cwd?: string }) => envMaterialize(options));

  const envKey = env.command("key").description("manage and share the machine-local secret key");

  envKey
    .command("share")
    .description("escrow the key in the map under a passphrase (recommended way to add a machine)")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--passphrase <passphrase>", "passphrase (omit to be prompted)")
    .action((options: { cwd?: string; passphrase?: string }) => envKeyShare(options));

  envKey
    .command("receive")
    .description("install the escrowed key from the map using its passphrase")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--passphrase <passphrase>", "passphrase (omit to be prompted)")
    .option("--force", "overwrite an existing key", false)
    .action((options: { cwd?: string; passphrase?: string; force?: boolean }) =>
      envKeyReceive(options),
    );

  envKey
    .command("revoke")
    .description("prune a stale escrowed-key entry from the map keyring")
    .argument("<label>", "the entry label (usually the hostname that shared it)")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .action((label: string, options: { cwd?: string }) => envKeyRevoke(label, options));

  envKey
    .command("export")
    .description("copy this machine's key to the clipboard (or --file/--stdout)")
    .option("--stdout", "print the raw key to stdout (history risk)", false)
    .option("--file <path>", "write the key to a 0600 file instead of the clipboard")
    .action((options: { stdout?: boolean; file?: string }) => envKeyExport(options));

  envKey
    .command("import")
    .description("install a secret key exported from another machine")
    .argument("[base64]", "the exported key (omit to read from prompt/stdin)")
    .option("--force", "overwrite an existing key", false)
    .option("--file <path>", "read the key from a file")
    .option("--stdin", "read the key from stdin", false)
    .action((base64: string | undefined, options: { force?: boolean; file?: string; stdin?: boolean }) =>
      envKeyImport(base64 ?? "", options),
    );

  const daemon = program
    .command("daemon")
    .description("run the background sync loop that keeps this workspace fresh");

  daemon
    .command("start")
    .description("start syncing on an interval (pull, reconcile, fast-forward, push)")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--once", "run a single sync and exit", false)
    .option("--interval <seconds>", "seconds between syncs", (v) => Number.parseInt(v, 10))
    .option("--eager", "clone repos instead of writing placeholders", false)
    .option("--no-fetch", "skip fetching remotes / freshness checks")
    .option("--no-fast-forward", "assess freshness but never fast-forward repos")
    .action(
      (
        workspacePath: string,
        // Commander defaults negatable flags to true; only treat them as set
        // when explicitly negated, so `boot.yaml` defaults still apply otherwise.
        options: { once?: boolean; interval?: number; eager?: boolean; fetch: boolean; fastForward: boolean },
      ) => {
        const start: DaemonStartOptions = {
          once: options.once,
          interval: options.interval,
          eager: options.eager,
          fetch: options.fetch === false ? false : undefined,
          fastForward: options.fastForward === false ? false : undefined,
        };
        return daemonStart(workspacePath, start);
      },
    );

  daemon
    .command("stop")
    .description("stop the running daemon for a workspace")
    .argument("[workspacePath]", "workspace directory", ".")
    .action((workspacePath: string) => daemonStop(workspacePath));

  daemon
    .command("status")
    .description("show whether the daemon is running and its last sync")
    .argument("[workspacePath]", "workspace directory", ".")
    .action((workspacePath: string) => daemonStatus(workspacePath));

  daemon
    .command("install")
    .description("install the daemon as a managed service (launchd/macOS, systemd/Linux, Scheduled Tasks/Windows)")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--interval <seconds>", "seconds between syncs", (v) => Number.parseInt(v, 10))
    .option("--entry <path>", "path to the boot CLI entry the service should run")
    .action((workspacePath: string, options: { interval?: number; entry?: string }) =>
      daemonInstall(workspacePath, { intervalSeconds: options.interval, entry: options.entry }),
    );

  daemon
    .command("uninstall")
    .description("remove the managed daemon service for a workspace")
    .argument("[workspacePath]", "workspace directory", ".")
    .action((workspacePath: string) => daemonUninstall(workspacePath));

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
