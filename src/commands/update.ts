import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { colors, logger } from "../ui/logger";
import { withSpinner } from "../ui/progress";

export interface UpdateOptions {
  /**
   * What to update to. For a source/git checkout this is a branch, tag, or
   * commit (default: the current branch, else main). For a standalone binary
   * install it is a release tag like `v0.1.0` (default: the latest release).
   */
  ref?: string;
}

/** Public install scripts — used to re-download standalone binary installs. */
const INSTALL_URL = "https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh";
const INSTALL_URL_PS1 = "https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.ps1";

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function retryCommand(options: UpdateOptions): string {
  return options.ref ? `boot update --ref ${commandArg(options.ref)}` : "boot update";
}

/**
 * Walk up from a starting file to the git checkout that boot is installed in
 * (the dir that has both a `.git` and a `package.json`). Works whether we're
 * running from the bundled `dist/index.js` or from source under `src/`.
 */
export function findAppRoot(startFile: string): string | null {
  let dir = path.dirname(startFile);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, ".git")) && existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readPkgVersion(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "?";
  } catch {
    return "?";
  }
}

async function gitOut(root: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", root, ...args]);
  return stdout.trim();
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execa(cmd, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-update. A from-source/git checkout is updated in place (pull + rebuild);
 * a standalone binary install is refreshed by re-running the public installer,
 * which downloads the latest released binary for this platform.
 */
export async function updateCommand(options: UpdateOptions = {}): Promise<void> {
  const root = findAppRoot(fileURLToPath(import.meta.url));

  // A git checkout (dev clone or from-source install) → pull + rebuild.
  if (root && existsSync(path.join(root, ".git"))) {
    await updateFromSource(root, options);
    return;
  }

  // Anything else (a compiled binary on PATH) → re-download via the installer.
  await updateBinary(options);
}

/** Re-run the installer to download the latest released binary for this platform. */
async function updateBinary(options: UpdateOptions): Promise<void> {
  if (process.platform === "win32") {
    await updateBinaryWindows(options);
    return;
  }

  await updateBinaryUnix(options);
}

/** Unix self-update via the public installer script. Exported for regression testing. */
export async function updateBinaryUnix(options: UpdateOptions): Promise<void> {
  if (!(await hasCommand("bash")) || !(await hasCommand("curl"))) {
    logger.error("Cannot update because `curl` or `bash` is missing from PATH.");
    logger.next(`Install the missing tool, then run: ${retryCommand(options)}`);
    return;
  }

  const target = options.ref ?? "latest";
  logger.heading(`Updating boot (${colors.cyan(target)} release)`);

  const env = { ...process.env };
  if (options.ref) env.BOOT_VERSION = options.ref;

  // Replacing the currently-running binary is safe on Unix: this process keeps
  // the old inode while the installer writes the new file into place.
  await execa("bash", ["-c", `set -o pipefail; curl -fsSL ${INSTALL_URL} | bash`], {
    env,
    stdio: "inherit",
  });
  logger.success("boot updated. Run `boot --version` to confirm.");
}

/** Windows self-update: run the PowerShell installer, which swaps the binary in place. */
async function updateBinaryWindows(options: UpdateOptions): Promise<void> {
  const pwsh = (await hasCommand("pwsh")) ? "pwsh" : "powershell";
  const target = options.ref ?? "latest";
  logger.heading(`Updating boot (${colors.cyan(target)} release)`);

  const env = { ...process.env };
  if (options.ref) env.BOOT_VERSION = options.ref;

  // The installer renames the running boot.exe aside before writing the new one,
  // so an in-place self-update works even though Windows locks the live binary.
  await execa(
    pwsh,
    ["-NoProfile", "-Command", `irm ${INSTALL_URL_PS1} | iex`],
    { env, stdio: "inherit" },
  );
  logger.success("boot updated. Open a new terminal and run `boot --version` to confirm.");
}

/** Pull the latest source into a git checkout and rebuild, mirroring the installer. */
async function updateFromSource(root: string, options: UpdateOptions): Promise<void> {
  logger.heading(`Updating boot in ${colors.cyan(root)}`);

  // Refuse to clobber a checkout with local edits (e.g. a dev clone).
  const dirty = await gitOut(root, ["status", "--porcelain"]).catch(() => "");
  if (dirty) {
    logger.error("Cannot update because the install directory has local changes.");
    logger.next(`Commit or stash them, then run: ${retryCommand(options)}`);
    return;
  }

  const oldVersion = await readPkgVersion(root);

  let ref = options.ref;
  if (!ref) {
    const branch = await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
    ref = branch && branch !== "HEAD" ? branch : "main";
  }

  const before = await gitOut(root, ["rev-parse", "HEAD"]).catch(() => "");

  await withSpinner(`fetching ${ref}`, () =>
    execa("git", ["-C", root, "fetch", "--depth", "1", "origin", ref!]),
  );
  const target = await gitOut(root, ["rev-parse", "FETCH_HEAD"]).catch(() => "");

  if (before && target && before === target) {
    logger.success(`already up to date (v${oldVersion}).`);
    return;
  }

  await execa("git", ["-C", root, "checkout", "-q", "FETCH_HEAD"]);

  const pm = (await hasCommand("pnpm")) ? "pnpm" : "npm";
  await withSpinner(`installing dependencies (${pm})`, () => execa(pm, ["install"], { cwd: root }));
  await withSpinner("building", () => execa(pm, ["run", "build"], { cwd: root }));

  const entry = path.join(root, "dist", "index.js");
  if (!existsSync(entry)) {
    logger.error(`build did not produce ${entry}.`);
    return;
  }

  const newVersion = await readPkgVersion(root);
  logger.info();
  if (oldVersion === newVersion) {
    logger.success(`Updated to the latest ${ref} (v${newVersion}).`);
  } else {
    logger.success(`Updated boot ${colors.dim(`v${oldVersion}`)} → ${colors.cyan(`v${newVersion}`)}.`);
  }
}
