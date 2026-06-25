import { stdout } from "node:process";
import { colors, logger } from "./logger";

const FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
const useTTY = (): boolean => Boolean(stdout.isTTY) && !process.env.NO_COLOR;

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `[3/12]` style counter prefix, dimmed. */
export function stepPrefix(index: number, total: number): string {
  return colors.dim(`[${index}/${total}]`);
}

/**
 * Run `fn` while showing live feedback. On a TTY it animates a spinner on one
 * line; otherwise it prints a start line and a done line. Either way it reports
 * elapsed time, so long clones/hydrations never feel silent.
 */
export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();

  if (!useTTY()) {
    logger.info(colors.dim(`\u2026 ${label}`));
    try {
      const result = await fn();
      logger.success(`${label} ${colors.dim(`(${fmtMs(Date.now() - start)})`)}`);
      return result;
    } catch (err) {
      logger.error(`${label} failed`);
      throw err;
    }
  }

  let i = 0;
  const render = (): void => {
    stdout.write(`\r${colors.cyan(FRAMES[i % FRAMES.length]!)} ${label}\x1b[K`);
    i += 1;
  };
  render();
  const timer = setInterval(render, 80);
  if (typeof timer.unref === "function") timer.unref();

  const clearLine = (): void => {
    stdout.write("\r\x1b[K");
  };
  try {
    const result = await fn();
    clearInterval(timer);
    clearLine();
    logger.success(`${label} ${colors.dim(`(${fmtMs(Date.now() - start)})`)}`);
    return result;
  } catch (err) {
    clearInterval(timer);
    clearLine();
    logger.error(`${label} failed`);
    throw err;
  }
}
