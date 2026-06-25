/**
 * Tiny zero-dependency logger with optional ANSI colour.
 * Colour is disabled automatically when not a TTY or when NO_COLOR is set.
 */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const colors = {
  green: (s: string) => paint("32", s),
  red: (s: string) => paint("31", s),
  yellow: (s: string) => paint("33", s),
  cyan: (s: string) => paint("36", s),
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
};

export const logger = {
  /** Plain line, no decoration. */
  info(message = ""): void {
    console.log(message);
  },
  heading(message: string): void {
    console.log(colors.bold(message));
  },
  success(message: string): void {
    console.log(`${colors.green("\u2713")} ${message}`);
  },
  warn(message: string): void {
    console.log(`${colors.yellow("\u26a0")} ${message}`);
  },
  error(message: string): void {
    console.error(`${colors.red("\u2717")} ${message}`);
  },
  /** A dim "what to do next" suggestion, shown after a command finishes. */
  next(message: string): void {
    console.log(colors.dim(`\u2192 ${message}`));
  },
};
