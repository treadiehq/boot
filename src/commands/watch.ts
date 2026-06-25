import path from "node:path";
import { startWatcher } from "../core/watcher";
import { colors, logger } from "../ui/logger";

export interface WatchCommandOptions {
  debounce?: number;
}

/**
 * Long-running command: watch the workspace and hydrate placeholders the moment
 * a tool or editor touches them. Stays in the foreground until interrupted.
 */
export async function watchCommand(
  workspacePath = ".",
  options: WatchCommandOptions = {},
): Promise<void> {
  const root = path.resolve(workspacePath);
  const label = path.relative(process.cwd(), root) || ".";

  logger.heading(`Watching ${colors.cyan(label)} for on-access hydration`);

  const watcher = await startWatcher(
    root,
    {
      onReady: (placeholders, mode) => {
        if (placeholders.length === 0) {
          logger.info(colors.dim("no placeholders to watch yet — nothing lazy here."));
        } else {
          logger.success(
            `armed ${placeholders.length} placeholder${placeholders.length === 1 ? "" : "s"} (${mode})`,
          );
        }
      },
      onActivity: (dir) => logger.info(`${colors.dim("\u2022")} activity in ${path.relative(root, dir)}`),
      onHydrated: (dir) => logger.success(`hydrated ${colors.cyan(path.relative(root, dir))}`),
      onError: (err) => logger.error(err.message),
    },
    { debounceMs: options.debounce },
  );

  logger.info(colors.dim("Press Ctrl+C to stop."));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void watcher.close().then(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
