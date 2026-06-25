import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { colors } from "./logger";

/** Whether we can actually ask the user something (both ends are a terminal). */
export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export interface ConfirmOptions {
  /** Answer used for empty input and in non-interactive mode. */
  default?: boolean;
  /** Skip the prompt entirely and return true (e.g. `--yes`). */
  assumeYes?: boolean;
}

/**
 * Yes/no prompt. Falls back to the default (no blocking) when stdin isn't a TTY,
 * so the same code path works in scripts, CI, and pipes.
 */
export async function confirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
  const def = options.default ?? true;
  if (options.assumeYes) return true;
  if (!isInteractive()) return def;

  const hint = def ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} ${colors.dim(hint)} `)).trim().toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export interface Choice<T> {
  label: string;
  value: T;
}

/** Single-choice menu; returns the default choice in non-interactive mode. */
export async function select<T>(
  question: string,
  choices: Choice<T>[],
  options: { default?: number; assumeYes?: boolean } = {},
): Promise<T> {
  const defIdx = options.default ?? 0;
  if (options.assumeYes || !isInteractive()) return choices[defIdx]!.value;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`${question}\n`);
    choices.forEach((c, i) => {
      const marker = i === defIdx ? colors.dim(" (default)") : "";
      stdout.write(`  ${i + 1}) ${c.label}${marker}\n`);
    });
    const answer = (await rl.question(colors.dim(`Choose 1-${choices.length}: `))).trim();
    if (answer === "") return choices[defIdx]!.value;
    const n = Number.parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    return choices[defIdx]!.value;
  } finally {
    rl.close();
  }
}

/**
 * Hidden prompt for secrets (passphrases). Echoes nothing as you type. In
 * non-interactive mode it reads a single line from stdin so it still works in
 * pipes, returning "" if there's nothing to read.
 */
export async function password(question: string): Promise<string> {
  if (!isInteractive()) {
    return readLineFromStdin();
  }
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  // Mute echo: the readline interface writes the prompt, then we swallow keystrokes.
  const muted = { on: false };
  const realWrite = (stdout as NodeJS.WriteStream).write.bind(stdout);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (muted.on) {
      // Allow the newline through so the cursor advances on Enter.
      if (s.includes("\n")) realWrite("\n");
      return;
    }
    realWrite(s);
  };
  try {
    const promise = rl.question(`${question} `);
    muted.on = true;
    const answer = await promise;
    return answer;
  } finally {
    rl.close();
  }
}

/** Read one line from stdin without a TTY (e.g. `echo pass | boot …`). */
function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        cleanup();
        resolve(buf.slice(0, nl).replace(/\r$/, ""));
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(buf.trim());
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
    };
    if (!stdin.readable) {
      resolve("");
      return;
    }
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** Free-text prompt; returns the default in non-interactive mode. */
export async function input(
  question: string,
  options: { default?: string; assumeYes?: boolean } = {},
): Promise<string> {
  const def = options.default ?? "";
  if (options.assumeYes || !isInteractive()) return def;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} `)).trim();
    return answer === "" ? def : answer;
  } finally {
    rl.close();
  }
}
