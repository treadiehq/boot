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
      "Put the same repo layout on every machine. Repos appear instantly and clone when opened.",
    )
    .version(VERSION, "-v, --version", "print boot's version and exit");

  program.commandsGroup("Getting started:");

  program
    .command("version")
    .description("print boot's version and exit")
    .action(() => logger.info(VERSION));

  program
    .command("setup")
    .description("set up this machine: layout, secrets, shell hook, and background sync")
    .argument("[remote]", "map repo URL (or synced folder with --folder); omit if already linked")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--folder", "use a synced folder instead of a git repo for the map", false)
    .option("--eager", "clone every repo now instead of creating placeholders", false)
    .option("-y, --yes", "accept all prompts (non-interactive)", false)
    .option("--no-hook", "skip installing the shell hook")
    .option("--no-daemon", "skip the background sync service")
    .option("--no-key", "skip secret-key setup")
    .option("--import-key <base64>", "install a secret key exported from another machine")
    .option("--shell <shell>", "shell for the hook (zsh|bash|fish|powershell; auto-detected otherwise)")
    .option("--interval <seconds>", "daemon sync interval", (v) => Number.parseInt(v, 10))
    .option("--mount <mountpoint>", "show this mount path in the setup summary")
    .action((remote: string | undefined, workspacePath: string, options: SetupOptions) =>
      setupCommand(remote, workspacePath, options),
    );

  program
    .command("init")
    .description("write default boot config files")
    .argument("<workspacePath>", "path to the workspace to initialize")
    .option("-f, --force", "overwrite existing files", false)
    .action((workspacePath: string, options: InitOptions) => initCommand(workspacePath, options));

  program
    .command("update")
    .description("update boot itself to the latest version")
    .option("--ref <ref>", "release tag (binary install) or git ref (source install) to update to")
    .action((options: UpdateOptions) => updateCommand(options));

  program.commandsGroup("One-time snapshots:");

  program
    .command("export")
    .alias("scan")
    .description("save this workspace's repo list to a file")
    .argument("<workspacePath>", "path to the workspace to snapshot")
    .option("-o, --output <file>", "output snapshot path", DEFAULT_MANIFEST_NAME)
    .action((workspacePath: string, options: ScanOptions) => scanCommand(workspacePath, options));

  program
    .command("list")
    .description("show the repos in a snapshot file")
    .argument("<manifestPath>", "path to a boot snapshot file")
    .action((manifestPath: string) => listCommand(manifestPath));

  program
    .command("import")
    .alias("restore")
    .description("recreate folders and repos from a snapshot file")
    .argument("<manifestPath>", "path to a boot snapshot file")
    .argument("<targetPath>", "directory to recreate the workspace into")
    .option("--lazy", "create placeholders instead of cloning repos", false)
    .action((manifestPath: string, targetPath: string, options: RestoreOptions) =>
      restoreCommand(manifestPath, targetPath, options),
    );

  program.commandsGroup("Clone repos on demand:");

  program
    .command("hydrate")
    .description("clone a placeholder repo now")
    .argument("<repoPath>", "path to a placeholder repo folder")
    .action((repoPath: string) => hydrateCommand(repoPath));

  program
    .command("enter")
    .description("clone the placeholder at this path")
    .argument("[targetPath]", "directory you are entering", ".")
    .option("-q, --quiet", "print nothing (used by the shell hook)", false)
    .action((targetPath: string, options: { quiet?: boolean }) =>
      enterCommand(targetPath, { quiet: options.quiet }),
    );

  program
    .command("cd")
    .description("find a repo by name and print its path, cloning it first if needed")
    .argument("[query]", "fuzzy repo name or path; omit to browse interactively")
    .option("-C, --cwd <path>", "workspace directory (or anywhere inside it)", ".")
    .option("--print", "print only the resolved path to stdout (used by `bcd`)", false)
    .option("--json", "print the match as a JSON line to stdout", false)
    .action((query: string | undefined, options: CdOptions) => cdCommand(query ?? "", options));

  program
    .command("shell-hook")
    .description("print the shell snippet for auto-clone on cd and the `bcd` jump command")
    .argument("[shell]", "zsh, bash, fish, or powershell (auto-detected if omitted)")
    .action((shell?: string) => shellHookCommand(shell));

  program
    .command("watch")
    .description("clone a placeholder when a tool writes into it")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--debounce <ms>", "milliseconds to wait after activity", (v) => Number.parseInt(v, 10))
    .action((workspacePath: string, options: { debounce?: number }) =>
      watchCommand(workspacePath, { debounce: options.debounce }),
    );

  program
    .command("mount")
    .description("open a workspace through a mount that clones repos on first read (needs FUSE)")
    .argument("<workspacePath>", "workspace directory to expose")
    .argument("<mountpoint>", "directory to mount the virtual workspace at")
    .option("--read-only", "reads can still clone repos, but writes fail (EROFS)", false)
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
    .description("show what is cloned, waiting, or dirty")
    .argument("<workspacePath>", "path to the workspace to inspect")
    .action((workspacePath: string) => statusCommand(workspacePath));

  program
    .command("doctor")
    .description("check a workspace for common problems")
    .argument("<workspacePath>", "path to the workspace to check")
    .option("--system", "check boot setup (link, key, hook, sync service, FUSE) instead of repos", false)
    .action((workspacePath: string, options: DoctorOptions) => doctorCommand(workspacePath, options));

  program.commandsGroup("Sync across machines:");

  program
    .command("link")
    .description("share this workspace layout with your other machines")
    .argument("<remote>", "map repo URL (or synced folder with --folder)")
    .argument("[workspacePath]", "workspace directory to link", ".")
    .option("--eager", "clone every repo now instead of creating placeholders", false)
    .option("--folder", "use a synced folder instead of a git repo for the map", false)
    .option("-y, --yes", "accept prompts, like creating a missing GitHub map repo", false)
    .action((remote: string, workspacePath: string, options: LinkOptions) =>
      linkCommand(remote, workspacePath, options),
    );

  program
    .command("push")
    .description("publish this machine's repo layout")
    .argument("[workspacePath]", "workspace directory", ".")
    .action((workspacePath: string) => pushCommand(workspacePath));

  program
    .command("pull")
    .description("bring in repo layout changes from other machines")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--eager", "clone every repo now instead of creating placeholders", false)
    .option("--dry-run", "show what would change without writing anything", false)
    .action((workspacePath: string, options: PullOptions) => pullCommand(workspacePath, options));

  program
    .command("agent")
    .description("set up a CI job or cloud agent from your shared layout")
    .argument("<remote>", "map repo URL (or synced folder with --folder)")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--eager", "clone every repo now instead of creating placeholders", false)
    .option("--all", "clone every placeholder after setup", false)
    .option(
      "--hydrate <patterns...>",
      "clone placeholders whose paths match these glob patterns",
    )
    .option("--env", "write env files if a secret key is present", false)
    .option("--folder", "use a synced folder instead of a git repo for the map", false)
    .option("--dry-run", "show what would change without writing anything", false)
    .action((remote: string, workspacePath: string, options: AgentOptions) =>
      agentCommand(remote, workspacePath, options),
    );

  const env = program
    .command("env")
    .description("store encrypted env vars in your shared layout");

  env
    .command("init")
    .description("create this machine's secret key for env vars")
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
    .description("write decrypted .env files into the workspace")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .action((options: { cwd?: string }) => envMaterialize(options));

  const envKey = env.command("key").description("move the machine-local secret key");

  envKey
    .command("share")
    .description("share this machine's key using a passphrase")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--passphrase <passphrase>", "passphrase (omit to be prompted)")
    .action((options: { cwd?: string; passphrase?: string }) => envKeyShare(options));

  envKey
    .command("receive")
    .description("install a shared key using its passphrase")
    .option("-C, --cwd <path>", "workspace directory", ".")
    .option("--passphrase <passphrase>", "passphrase (omit to be prompted)")
    .option("--force", "overwrite an existing key", false)
    .action((options: { cwd?: string; passphrase?: string; force?: boolean }) =>
      envKeyReceive(options),
    );

  envKey
    .command("revoke")
    .description("remove a shared-key entry from the map")
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
    .description("keep this workspace current in the background");

  daemon
    .command("start")
    .description("sync this workspace on an interval")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--once", "run a single sync and exit", false)
    .option("--interval <seconds>", "seconds between syncs", (v) => Number.parseInt(v, 10))
    .option("--eager", "clone every repo now instead of creating placeholders", false)
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
    .description("start background sync automatically when you log in")
    .argument("[workspacePath]", "workspace directory", ".")
    .option("--interval <seconds>", "seconds between syncs", (v) => Number.parseInt(v, 10))
    .option("--entry <path>", "path to the boot CLI entry the service should run")
    .action((workspacePath: string, options: { interval?: number; entry?: string }) =>
      daemonInstall(workspacePath, { intervalSeconds: options.interval, entry: options.entry }),
    );

  daemon
    .command("uninstall")
    .description("remove automatic background sync for a workspace")
    .argument("[workspacePath]", "workspace directory", ".")
    .action((workspacePath: string) => daemonUninstall(workspacePath));

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
