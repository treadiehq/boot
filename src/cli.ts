import { readFileSync } from "node:fs";
import { Command, Help, InvalidArgumentError } from "commander";
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
import { inspectCommand, type InspectOptions } from "./commands/inspect";
import { linkCommand, type LinkOptions } from "./commands/link";
import { listCommand } from "./commands/list";
import { mountCommand, unmountCommand } from "./commands/mount";
import { pullCommand, type PullOptions } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { restoreCommand, type RestoreOptions } from "./commands/restore";
import { scanCommand, type ScanOptions } from "./commands/scan";
import { saveCommand } from "./commands/save";
import { daemonInstall, daemonUninstall } from "./commands/service";
import { setupCommand, type SetupOptions } from "./commands/setup";
import { shellHookCommand } from "./commands/shellHook";
import { statusCommand } from "./commands/status";
import { updateCommand, type UpdateOptions } from "./commands/update";
import { upCommand, type UpOptions } from "./commands/up";
import { watchCommand } from "./commands/watch";
import { validateDaemonInterval } from "./core/service";
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

function parseDaemonInterval(value: string): number {
  try {
    return validateDaemonInterval(Number(value));
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("boot")
    .description(
      "Set up a project workspace with the repositories, tools, and settings a developer or coding agent needs.",
    )
    .configureHelp({
      optionDescription: (option) =>
        option.defaultValue === false ? option.description : new Help().optionDescription(option),
    })
    .showHelpAfterError()
    .helpOption("-h, --help", "show help")
    .helpCommand("help [command]", "show help for a command")
    .version(VERSION, "-v, --version", "show the installed version");

  program.commandsGroup("Primary workspace commands:");

  program
    .command("init")
    .description("discover a workspace and write boot.yaml")
    .argument("[workspacePath]", "workspace to inspect", ".")
    .option("-f, --force", "replace an existing boot.yaml", false)
    .action((workspacePath: string, options: InitOptions) => initCommand(workspacePath, options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot init\n  boot init ~/code\n  boot init . --force\n",
    );

  program
    .command("save")
    .description("publish boot.yaml to the linked workspace map")
    .argument("[workspacePath]", "workspace to publish", ".")
    .action((workspacePath: string) => saveCommand(workspacePath))
    .addHelpText("after", "\nExamples:\n  boot save\n  boot save ~/code\n");

  program
    .command("up")
    .description("prepare a workspace from boot.yaml")
    .argument("[workspacePath]", "workspace to prepare", ".")
    .option("--profile <profile>", "workspace profile to prepare")
    .option("--provider <provider>", "workspace provider to use", "local")
    .option("--dry-run", "show the plan without changing the workspace", false)
    .option("--json", "write JSON only to stdout", false)
    .option("--no-env", "check encrypted values without writing .env files")
    .option("--run-setup", "run setup commands from boot.yaml", false)
    .action((workspacePath: string, options: UpOptions) => upCommand(workspacePath, options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot up\n  boot up . --profile agent\n  boot up . --profile agent --dry-run --json\n  boot up . --run-setup\n",
    );

  program
    .command("inspect")
    .description("show workspace details for people or coding agents")
    .argument("[workspacePath]", "workspace to inspect", ".")
    .option("--profile <profile>", "workspace profile to inspect")
    .option("--provider <provider>", "workspace provider to inspect", "local")
    .option("--json", "write JSON only to stdout", false)
    .action((workspacePath: string, options: InspectOptions) =>
      inspectCommand(workspacePath, options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot inspect\n  boot inspect . --profile agent\n  boot inspect . --json\n",
    );

  program
    .command("agent")
    .description("prepare a fresh CI or cloud-agent workspace in one step")
    .argument("<remote>", "published workspace map URL or synced folder")
    .argument("[workspacePath]", "workspace to prepare", ".")
    .option("--profile <profile>", "workspace profile to prepare")
    .option("--provider <provider>", "workspace provider to use", "local")
    .option("--run-setup", "run selected setup commands from boot.yaml", false)
    .option("--env", "write encrypted environment values (compatibility alias)")
    .option("--no-env", "check encrypted values without writing .env files")
    .option("--folder", "use a synced folder for the workspace map", false)
    .option("--dry-run", "show the plan without changing the workspace", false)
    .option("--json", "write JSON only to stdout", false)
    .option("--eager", "clone every map repository (compatibility)", false)
    .option("--all", "clone every map placeholder (compatibility)", false)
    .option(
      "--hydrate <patterns...>",
      "clone map placeholders matching path globs (compatibility)",
    )
    .action((remote: string, workspacePath: string, options: AgentOptions) =>
      agentCommand(remote, workspacePath, options),
    )
    .addHelpText(
      "after",
      '\nExamples:\n  boot agent git@github.com:me/code-map.git ~/code\n  boot agent git@github.com:me/code-map.git ~/code --profile agent --run-setup\n  boot agent git@github.com:me/code-map.git ~/code --dry-run --json\n',
    );

  program.commandsGroup("Other commands:");

  program
    .command("version")
    .description("show the installed version")
    .action(() => logger.info(VERSION))
    .addHelpText("after", "\nExamples:\n  boot version\n");

  program
    .command("update")
    .description("update boot to the latest version")
    .option("--ref <ref>", "release tag or git ref to install")
    .action((options: UpdateOptions) => updateCommand(options))
    .addHelpText("after", "\nExamples:\n  boot update\n  boot update --ref HEAD\n");

  program.commandsGroup("Compatibility snapshot commands:");

  program
    .command("export")
    .alias("scan")
    .description("write a workspace repo snapshot")
    .argument("<workspacePath>", "workspace to scan")
    .option("-o, --output <file>", "snapshot file to write", DEFAULT_MANIFEST_NAME)
    .action((workspacePath: string, options: ScanOptions) => scanCommand(workspacePath, options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot export .\n  boot export ~/code --output team-workspace.json\n",
    );

  program
    .command("list")
    .description("show repos from a snapshot")
    .argument("<manifestPath>", "snapshot file to read")
    .action((manifestPath: string) => listCommand(manifestPath))
    .addHelpText("after", "\nExamples:\n  boot list boot-workspace.json\n");

  program
    .command("import")
    .alias("restore")
    .description("recreate a workspace from a snapshot")
    .argument("<manifestPath>", "snapshot file to read")
    .argument("<targetPath>", "directory to create")
    .option("--lazy", "write placeholders instead of cloning repos", false)
    .action((manifestPath: string, targetPath: string, options: RestoreOptions) =>
      restoreCommand(manifestPath, targetPath, options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot import boot-workspace.json ~/code\n  boot import boot-workspace.json ~/code --lazy\n",
    );

  program.commandsGroup("Compatibility on-demand cloning:");

  program
    .command("hydrate")
    .description("clone a placeholder repo")
    .argument("<repoPath>", "placeholder repo to clone")
    .action((repoPath: string) => hydrateCommand(repoPath))
    .addHelpText("after", "\nExamples:\n  boot hydrate ~/code/api\n");

  program
    .command("enter")
    .description("clone the placeholder at a path")
    .argument("[targetPath]", "directory to enter", ".")
    .option("-q, --quiet", "write no output", false)
    .action((targetPath: string, options: { quiet?: boolean }) =>
      enterCommand(targetPath, { quiet: options.quiet }),
    )
    .addHelpText("after", "\nExamples:\n  boot enter\n  boot enter ~/code/api\n");

  program
    .command("cd")
    .description("find a repo and print its path, cloning it if needed")
    .argument("[query]", "repo name or path; omit to choose interactively")
    .option("-C, --cwd <path>", "workspace or a directory inside it", ".")
    .option("--print", "write only the resolved path to stdout", false)
    .option("--json", "write one JSON object only to stdout", false)
    .action((query: string | undefined, options: CdOptions) => cdCommand(query ?? "", options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot cd api\n  boot cd api -C ~/code\n  boot cd api -C ~/code --json\n",
    );

  program
    .command("shell-hook")
    .description("print setup code for repo cloning and the bcd command")
    .argument("[shell]", "shell name; omit to detect it")
    .action((shell?: string) => shellHookCommand(shell))
    .addHelpText(
      "after",
      "\nExamples:\n  boot shell-hook zsh\n  boot shell-hook powershell\n",
    );

  program
    .command("watch")
    .description("clone placeholder repos after writes; runs in the foreground")
    .argument("[workspacePath]", "workspace to watch", ".")
    .option("--debounce <ms>", "milliseconds to wait after a write", (v) =>
      Number.parseInt(v, 10),
    )
    .action((workspacePath: string, options: { debounce?: number }) =>
      watchCommand(workspacePath, { debounce: options.debounce }),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot watch\n  boot watch ~/code --debounce 250\n",
    );

  program
    .command("mount")
    .description("mount a workspace with FUSE and clone repos on read; runs in the foreground")
    .argument("<workspacePath>", "workspace to expose")
    .argument("<mountpoint>", "directory to mount it at")
    .option("--read-only", "allow reads and repo cloning but reject writes", false)
    .option("--debug", "show FUSE operations", false)
    .action((workspacePath: string, mountpoint: string, options: { debug?: boolean; readOnly?: boolean }) =>
      mountCommand(workspacePath, mountpoint, { debug: options.debug, readOnly: options.readOnly }),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot mount ~/code ~/mnt/code\n  boot mount ~/code ~/mnt/code --read-only\n",
    );

  program
    .command("unmount")
    .description("unmount a workspace opened by boot mount")
    .argument("<mountpoint>", "mounted directory to close")
    .action((mountpoint: string) => unmountCommand(mountpoint))
    .addHelpText("after", "\nExamples:\n  boot unmount ~/mnt/code\n");

  program.commandsGroup("Compatibility status and checks:");

  program
    .command("status")
    .description("show cloned, placeholder, and changed repos")
    .argument("<workspacePath>", "workspace to inspect")
    .action((workspacePath: string) => statusCommand(workspacePath))
    .addHelpText("after", "\nExamples:\n  boot status ~/code\n");

  program
    .command("doctor")
    .description("check a workspace for common problems")
    .argument("<workspacePath>", "workspace to check")
    .option("--system", "check the link, key, shell hook, sync service, and FUSE", false)
    .action((workspacePath: string, options: DoctorOptions) =>
      doctorCommand(workspacePath, options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot doctor ~/code\n  boot doctor ~/code --system\n",
    );

  program.commandsGroup("Compatibility sync commands:");

  program
    .command("setup")
    .description("set up compatibility sync in one step")
    .argument("[remote]", "workspace map URL or synced folder; omit if linked")
    .argument("[workspacePath]", "workspace to set up", ".")
    .option("--folder", "use a synced folder for the workspace map", false)
    .option("--eager", "clone every repo instead of writing placeholders", false)
    .option("-y, --yes", "accept all prompts", false)
    .option("--no-hook", "do not install the shell hook")
    .option("--no-daemon", "do not install the sync service")
    .option("--no-key", "do not set up a secret key")
    .option("--import-key <base64>", "install an exported secret key")
    .option("--shell <shell>", "shell to configure; omit to detect it")
    .option("--interval <seconds>", "seconds between syncs", parseDaemonInterval)
    .option("--mount <mountpoint>", "mount path to include in the summary")
    .action((remote: string | undefined, workspacePath: string, options: SetupOptions) =>
      setupCommand(remote, workspacePath, options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot setup git@github.com:me/code-map.git ~/code --yes\n  boot setup ~/Sync/code-map ~/code --folder --yes\n",
    );

  program
    .command("link")
    .description("link a workspace to a shared workspace map")
    .argument("<remote>", "workspace map URL or synced folder")
    .argument("[workspacePath]", "workspace to link", ".")
    .option("--eager", "clone every repo instead of writing placeholders", false)
    .option("--folder", "use a synced folder for the workspace map", false)
    .option("-y, --yes", "accept prompts", false)
    .action((remote: string, workspacePath: string, options: LinkOptions) =>
      linkCommand(remote, workspacePath, options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot link git@github.com:me/code-map.git ~/code\n  boot link ~/Sync/code-map ~/code --folder\n",
    );

  program
    .command("push")
    .description("publish this machine's repo list")
    .argument("[workspacePath]", "workspace to publish", ".")
    .action((workspacePath: string) => pushCommand(workspacePath))
    .addHelpText("after", "\nExamples:\n  boot push\n  boot push ~/code\n");

  program
    .command("pull")
    .description("apply repo list changes from the workspace map")
    .argument("[workspacePath]", "workspace to update", ".")
    .option("--eager", "clone every repo instead of writing placeholders", false)
    .option("--dry-run", "show changes without writing files", false)
    .action((workspacePath: string, options: PullOptions) => pullCommand(workspacePath, options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot pull\n  boot pull ~/code --dry-run\n  boot pull ~/code --eager\n",
    );

  const env = program
    .command("env")
    .description("manage encrypted environment values in the workspace map");

  env
    .command("init")
    .description("create a secret key on this machine")
    .action(() => envInit())
    .addHelpText("after", "\nExamples:\n  boot env init\n");

  env
    .command("set")
    .description("store one or more environment values")
    .argument("<assignments...>", "values in KEY=VALUE form")
    .option("-C, --cwd <path>", "workspace to update", ".")
    .option("--repo <relativePath>", "repo path to update")
    .action((assignments: string[], options: { cwd?: string; repo?: string }) =>
      envSet(assignments, options),
    )
    .addHelpText(
      "after",
      '\nExamples:\n  boot env set API_URL=https://api.example.com -C ~/code\n  boot env set "LOG_LEVEL=debug" --repo services/api -C ~/code\n',
    );

  env
    .command("import")
    .description("store values from a .env file")
    .argument("<file>", ".env file to read")
    .option("-C, --cwd <path>", "workspace to update", ".")
    .option("--repo <relativePath>", "repo path to update")
    .action((file: string, options: { cwd?: string; repo?: string }) => envImport(file, options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot env import .env -C ~/code\n  boot env import services/api/.env --repo services/api -C ~/code\n",
    );

  env
    .command("list")
    .description("show stored environment keys without their values")
    .option("-C, --cwd <path>", "workspace to inspect", ".")
    .action((options: { cwd?: string }) => envList(options))
    .addHelpText("after", "\nExamples:\n  boot env list\n  boot env list -C ~/code\n");

  env
    .command("rm")
    .description("remove stored environment values")
    .argument("[keys...]", "environment keys to remove")
    .option("-C, --cwd <path>", "workspace to update", ".")
    .option("--repo <relativePath>", "repo path to update")
    .option("--all", "remove every value in the selected scope", false)
    .action((keys: string[], options: { cwd?: string; repo?: string; all?: boolean }) =>
      envRm(keys, options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot env rm API_TOKEN -C ~/code\n  boot env rm API_TOKEN --repo services/api -C ~/code\n  boot env rm --all -C ~/code\n",
    );

  env
    .command("materialize")
    .description("write decrypted values to .env files")
    .option("-C, --cwd <path>", "workspace to update", ".")
    .action((options: { cwd?: string }) => envMaterialize(options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot env materialize\n  boot env materialize -C ~/code\n",
    );

  const envKey = env.command("key").description("move or share this machine's secret key");

  envKey
    .command("share")
    .description("share this machine's key with a passphrase")
    .option("-C, --cwd <path>", "linked workspace to use", ".")
    .option("--passphrase <passphrase>", "passphrase; omit to enter it securely")
    .action((options: { cwd?: string; passphrase?: string }) => envKeyShare(options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot env key share\n  boot env key share -C ~/code\n",
    );

  envKey
    .command("receive")
    .description("install a shared key with its passphrase")
    .option("-C, --cwd <path>", "linked workspace to use", ".")
    .option("--passphrase <passphrase>", "passphrase; omit to enter it securely")
    .option("--force", "replace an existing key", false)
    .action((options: { cwd?: string; passphrase?: string; force?: boolean }) =>
      envKeyReceive(options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot env key receive\n  boot env key receive -C ~/code --force\n",
    );

  envKey
    .command("revoke")
    .description("remove a shared key from the workspace map")
    .argument("<label>", "shared key label to remove")
    .option("-C, --cwd <path>", "linked workspace to use", ".")
    .action((label: string, options: { cwd?: string }) => envKeyRevoke(label, options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot env key revoke old-laptop -C ~/code\n",
    );

  envKey
    .command("export")
    .description("export this machine's secret key")
    .option("--stdout", "write only the raw key to stdout", false)
    .option("--file <path>", "write the key to a private file")
    .action((options: { stdout?: boolean; file?: string }) => envKeyExport(options))
    .addHelpText(
      "after",
      "\nExamples:\n  boot env key export\n  boot env key export --file ./boot-key.txt\n",
    );

  envKey
    .command("import")
    .description("install an exported secret key")
    .argument("[base64]", "exported key; omit to read another input")
    .option("--force", "replace an existing key", false)
    .option("--file <path>", "read the key from a file")
    .option("--stdin", "read the key from stdin", false)
    .action((base64: string | undefined, options: { force?: boolean; file?: string; stdin?: boolean }) =>
      envKeyImport(base64 ?? "", options),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot env key import --file ./boot-key.txt\n",
    );

  const daemon = program
    .command("daemon")
    .description("run compatibility sync now or as a service");

  daemon
    .command("start")
    .description("sync a workspace in the foreground until stopped")
    .argument("[workspacePath]", "workspace to sync", ".")
    .option("--once", "sync once and exit", false)
    .option("--interval <seconds>", "seconds between syncs", parseDaemonInterval)
    .option("--eager", "clone every repo instead of writing placeholders", false)
    .option("--no-fetch", "do not fetch repos or check freshness")
    .option("--no-fast-forward", "check freshness without updating repos")
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
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot daemon start\n  boot daemon start ~/code --interval 60\n  boot daemon start ~/code --once\n",
    );

  daemon
    .command("stop")
    .description("stop foreground sync for a workspace")
    .argument("[workspacePath]", "workspace whose sync should stop", ".")
    .action((workspacePath: string) => daemonStop(workspacePath))
    .addHelpText("after", "\nExamples:\n  boot daemon stop\n  boot daemon stop ~/code\n");

  daemon
    .command("status")
    .description("show sync status and the last run")
    .argument("[workspacePath]", "workspace to inspect", ".")
    .action((workspacePath: string) => daemonStatus(workspacePath))
    .addHelpText(
      "after",
      "\nExamples:\n  boot daemon status\n  boot daemon status ~/code\n",
    );

  daemon
    .command("install")
    .description("set up background sync to start after login")
    .argument("[workspacePath]", "workspace to sync", ".")
    .option("--interval <seconds>", "seconds between syncs", parseDaemonInterval)
    .option("--entry <path>", "boot executable for the service to run")
    .action((workspacePath: string, options: { interval?: number; entry?: string }) =>
      daemonInstall(workspacePath, { intervalSeconds: options.interval, entry: options.entry }),
    )
    .addHelpText(
      "after",
      "\nExamples:\n  boot daemon install\n  boot daemon install ~/code --interval 60\n",
    );

  daemon
    .command("uninstall")
    .description("remove background sync for a workspace")
    .argument("[workspacePath]", "workspace to stop syncing", ".")
    .action((workspacePath: string) => daemonUninstall(workspacePath))
    .addHelpText(
      "after",
      "\nExamples:\n  boot daemon uninstall\n  boot daemon uninstall ~/code\n",
    );

  return program;
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
