import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CONFIG_FILE_NAME, loadConfig } from "../core/config";
import { recordWorkspace } from "../core/registry";
import { embeddedUiAssets } from "../core/uiEmbedded";
import { DEFAULT_UI_PORT, startUiServer } from "../core/uiServer";
import { colors, logger } from "../ui/logger";

export interface UiCommandOptions {
  port?: number;
  /** `--no-open` → false: don't launch a browser. */
  open?: boolean;
}

/**
 * Locate the built launchpad assets for a source checkout: walk up from this
 * module towards the package root looking for `ui/.output/public`. Release
 * binaries carry the assets embedded instead.
 */
function resolveDistDir(): string | null {
  if (process.env.BOOT_UI_DIST) return process.env.BOOT_UI_DIST;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, "ui", ".output", "public");
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    logger.info(colors.dim(`Could not open a browser automatically. Visit ${url}`));
  });
  child.unref();
}

/**
 * Serve the local launchpad: workspace list, readiness, and one-click
 * prepare/launch — a local web UI over the same core the CLI uses.
 */
export async function uiCommand(
  workspacePath = ".",
  options: UiCommandOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);

  // Register the workspace being pointed at so it appears in the launchpad.
  if (existsSync(path.join(root, CONFIG_FILE_NAME))) {
    const config = await loadConfig(root).catch(() => null);
    await recordWorkspace(root, config?.definition?.workspace.name ?? path.basename(root)).catch(
      () => {
        // Best-effort registration; the UI still serves the existing registry.
      },
    );
  }

  const distDir = resolveDistDir();
  if (!distDir && Object.keys(embeddedUiAssets).length === 0) {
    throw new Error(
      "The boot ui assets are not built. Run `pnpm ui:build` in the boot repository, or use a release binary.",
    );
  }

  const running = await startUiServer({ port: options.port ?? DEFAULT_UI_PORT, distDir });

  logger.heading(`boot ui — ${colors.cyan(running.url)}`);
  logger.info(colors.dim("Serving locally only (127.0.0.1). Press Ctrl-C to stop."));
  if (options.open !== false) openBrowser(running.url);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.close().then(resolve, () => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  logger.info("boot ui stopped.");
}
