import { CommandExitError } from "e2b";
import { sanitizeUserText } from "../../../src/core/userErrors";

export function formatE2BError(error: unknown): string {
  if (!(error instanceof CommandExitError)) {
    return sanitizeUserText(
      error instanceof Error ? error.message : String(error),
      Infinity,
    );
  }

  const parts = [`Command exited with code ${error.exitCode}`];
  const message = sanitizeUserText(error.message, Infinity);
  if (message && message !== `exit status ${error.exitCode}`) {
    parts[0] += `: ${message}`;
  }
  for (const [label, output] of [
    ["stderr", error.stderr],
    ["stdout", error.stdout],
  ]) {
    // Redact credentials and terminal controls without truncating away the
    // command's failure reason.
    const text = sanitizeUserText(output, Infinity);
    if (text) parts.push(`${label}: ${text}`);
  }
  return parts.join("\n");
}
