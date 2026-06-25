import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { loadConfig } from "../core/config";
import { isLinked, mapPaths } from "../core/map";
import {
  detectServicePlatform,
  installCommands,
  reloadCommand,
  renderService,
  serviceFilePath,
  serviceName,
  uninstallCommands,
  type ServiceCommand,
  type ServicePlatform,
} from "../core/service";
import { colors, logger } from "../ui/logger";

/** Executes a service-manager command, returning a tolerant result. */
export type ServiceRunner = (argv: string[]) => Promise<{ exitCode: number; output: string }>;

const defaultRunner: ServiceRunner = async (argv) => {
  const [cmd, ...rest] = argv;
  const res = await execa(cmd!, rest, { reject: false });
  return { exitCode: res.exitCode ?? 1, output: String(res.stderr || res.stdout).trim() };
};

export interface ServiceInstallOptions {
  intervalSeconds?: number;
  /** Overrides, primarily for testing. */
  platform?: ServicePlatform;
  home?: string;
  runner?: ServiceRunner;
  node?: string;
  entry?: string;
  pathEnv?: string;
}

export interface ServiceUninstallOptions {
  platform?: ServicePlatform;
  home?: string;
  runner?: ServiceRunner;
}

/** Absolute path to the boot CLI entry currently running. */
function resolveEntry(): string {
  const argv1 = process.argv[1];
  if (argv1) return path.resolve(argv1);
  return fileURLToPath(import.meta.url);
}

/** A PATH that includes common git locations on top of the current environment. */
function buildPathEnv(): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const current = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  return [...new Set([...extra, ...current])].join(path.delimiter);
}

async function runAll(commands: ServiceCommand[], runner: ServiceRunner): Promise<void> {
  for (const cmd of commands) {
    const { exitCode, output } = await runner(cmd.argv);
    if (exitCode !== 0 && !cmd.ignoreError) {
      throw new Error(`\`${cmd.argv.join(" ")}\` failed: ${output || `exit ${exitCode}`}`);
    }
  }
}

export async function daemonInstall(
  workspacePath = ".",
  options: ServiceInstallOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  if (!isLinked(root)) {
    throw new Error(`${root} is not linked. Run \`boot link <remote> ${workspacePath}\` first.`);
  }

  const platform = options.platform ?? detectServicePlatform();
  if (!platform) {
    throw new Error(
      `Managed services are only supported on macOS (launchd) and Linux (systemd). ` +
        `On this platform, run \`boot daemon start\` yourself.`,
    );
  }

  const home = options.home ?? os.homedir();
  const config = await loadConfig(root);
  const intervalSeconds = options.intervalSeconds ?? config.daemonIntervalSeconds;
  const entry = options.entry ?? resolveEntry();

  if (entry.endsWith(".ts")) {
    logger.warn(
      "Installing a service that points at a TypeScript entry. Run `pnpm build` and install " +
        "the built `boot` (or pass --entry) so the service can start without tsx.",
    );
  }

  const paths = mapPaths(root);
  await fs.mkdir(paths.bootDir, { recursive: true });

  const spec = {
    root: paths.root,
    node: options.node ?? process.execPath,
    entry,
    intervalSeconds,
    logFile: path.join(paths.bootDir, "daemon.log"),
    errFile: path.join(paths.bootDir, "daemon.err.log"),
    pathEnv: options.pathEnv ?? buildPathEnv(),
  };

  const filePath = serviceFilePath(platform, root, home);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, renderService(platform, root, spec), "utf8");

  logger.heading(`Installing ${colors.cyan(serviceName(platform, root))} (${platform})`);
  logger.success(`wrote ${filePath}`);

  const uid = process.getuid?.() ?? 0;
  const runner = options.runner ?? defaultRunner;
  await runAll(installCommands(platform, root, filePath, uid), runner);

  logger.success("service loaded and enabled");
  logger.info();
  logger.info(`The daemon now syncs ${colors.cyan(root)} every ${intervalSeconds}s and restarts on boot.`);
  logger.info(colors.dim(`Logs: ${spec.logFile}`));
  logger.info(colors.dim("Remove it with:  boot daemon uninstall"));
}

export async function daemonUninstall(
  workspacePath = ".",
  options: ServiceUninstallOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);

  const platform = options.platform ?? detectServicePlatform();
  if (!platform) {
    throw new Error("Managed services are not supported on this platform.");
  }

  const home = options.home ?? os.homedir();
  const filePath = serviceFilePath(platform, root, home);
  const runner = options.runner ?? defaultRunner;

  logger.heading(`Removing ${colors.cyan(serviceName(platform, root))} (${platform})`);

  const uid = process.getuid?.() ?? 0;
  await runAll(uninstallCommands(platform, root, uid), runner);

  await fs.rm(filePath, { force: true });
  logger.success(`removed ${filePath}`);

  const reload = reloadCommand(platform);
  if (reload) await runAll([reload], runner);

  logger.info();
  logger.success("Service removed. The background daemon will no longer run.");
}
