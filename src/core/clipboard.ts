import { execa } from "execa";

interface ClipboardTool {
  cmd: string;
  args: string[];
}

/** Candidate copy commands per platform, in preference order. */
function candidates(): ClipboardTool[] {
  if (process.platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (process.platform === "win32") return [{ cmd: "clip", args: [] }];
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/**
 * Copy text to the system clipboard. Returns true on success, false when no
 * clipboard tool is available — callers fall back to a file in that case.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  for (const { cmd, args } of candidates()) {
    try {
      await execa(cmd, args, { input: text });
      return true;
    } catch {
      // Tool missing or failed — try the next one.
    }
  }
  return false;
}
