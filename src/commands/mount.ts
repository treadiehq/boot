import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createFuseOps, OverlayFs, type FuseOperations } from "../core/vfs";
import { colors, logger } from "../ui/logger";

/* Minimal shape of the optional `fuse-native` binding (it ships no types). */
interface FuseInstance {
  mount(cb: (err: Error | null) => void): void;
  unmount(cb: (err: Error | null) => void): void;
}
interface FuseCtor {
  new (mnt: string, ops: FuseOperations, opts?: Record<string, unknown>): FuseInstance;
  unmount(mnt: string, cb: (err: Error | null) => void): void;
  isConfigured(cb: (err: Error | null, configured: boolean) => void): void;
}

const FUSE_INSTALL_HELP = `Mounting needs system FUSE and the optional 'fuse-native' module.

  macOS:  brew install --cask macfuse        (then approve the system extension)
  Linux:  sudo apt install fuse3 libfuse-dev  (or your distro's equivalent)
  then:   pnpm add fuse-native

Without it, \`boot shell-hook\` and \`boot watch\` can still clone repository placeholders on access.`;

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Lazily load the native binding so the package installs without it. */
function loadFuse(): FuseCtor {
  const require = createRequire(import.meta.url);
  try {
    return require("fuse-native") as FuseCtor;
  } catch {
    throw new Error(`'fuse-native' is not installed.\n\n${FUSE_INSTALL_HELP}`);
  }
}

export interface MountOptions {
  /** Print FUSE op traffic (passed through to the binding). */
  debug?: boolean;
  /** Mount read-only (reads hydrate, writes fail with EROFS). */
  readOnly?: boolean;
}

/**
 * Mount a workspace as a virtual filesystem that hydrates placeholders the
 * instant any file inside one is read — so even a passive `cat` materialises
 * the repo. Runs in the foreground until interrupted.
 */
export async function mountCommand(
  workspacePath: string,
  mountpoint: string,
  options: MountOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  const mnt = path.resolve(mountpoint);

  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Path is not a workspace directory: ${root}`);
  }
  await fs.mkdir(mnt, { recursive: true });

  const Fuse = loadFuse();

  const overlay = new OverlayFs(
    root,
    {
      onHydrate: (dir) => logger.success(`Cloned ${colors.cyan(path.relative(root, dir))}.`),
      onError: (err) => logger.error(err.message),
    },
    { readOnly: options.readOnly },
  );
  const ops = createFuseOps(overlay);

  const fuse = new Fuse(mnt, ops, {
    force: true,
    mkdir: false,
    displayFolder: true,
    debug: options.debug,
    readOnly: options.readOnly,
  });

  const mode = options.readOnly ? colors.dim(" (read-only)") : "";
  logger.heading(
    `Mounting ${colors.cyan(path.relative(process.cwd(), root) || ".")} at ${colors.cyan(mnt)}${mode}`,
  );

  await new Promise<void>((resolve, reject) => {
    fuse.mount((err) => (err ? reject(err) : resolve()));
  });

  logger.success("Mounted. Repository placeholders clone on first read.");
  logger.info(colors.dim("Press Ctrl+C to unmount."));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      fuse.unmount((err) => {
        if (err) {
          logger.error(
            `Could not unmount: ${err.message}. Try: boot unmount ${commandArg(mnt)}`,
          );
        }
        else logger.info("Unmounted.");
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Force-unmount a previously mounted workspace. */
export async function unmountCommand(mountpoint: string): Promise<void> {
  const mnt = path.resolve(mountpoint);
  const Fuse = loadFuse();
  await new Promise<void>((resolve, reject) => {
    Fuse.unmount(mnt, (err) => (err ? reject(err) : resolve()));
  });
  logger.success(`Unmounted ${colors.cyan(mnt)}.`);
}
