import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex === -1 ? path.join(root, "src/core/sessionNativeEmbedded.ts") : path.resolve(process.argv[outputIndex + 1]);
if (process.argv.includes("--reset")) {
  await fs.writeFile(output, "/** Replaced with signed helper bytes by scripts/embed-session-native.mjs for releases. */\nexport const embeddedCloneHelpers: Record<string, string> = {};\n");
} else {
  if (process.platform !== "darwin") throw new Error("Build the APFS helpers on macOS before making a macOS release.");
  const source = (await fs.readFile(path.join(root, "src/core/sessionNative.ts"), "utf8")).match(/MAC_CLONE_SOURCE = String\.raw`([\s\S]*?)`;/)?.[1];
  if (!source) throw new Error("Native clonefile source was not found.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "boot-native-build-"));
  try {
    const input = path.join(directory, "clonefile.c");
    await fs.writeFile(input, source);
    const helpers = {};
    for (const [key, architecture] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
      const binary = path.join(directory, `clonefile-${key}`);
      execFileSync("/usr/bin/clang", ["-O2", "-Wall", "-Werror", "-arch", architecture, input, "-o", binary]);
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binary]);
      helpers[key] = (await fs.readFile(binary)).toString("base64");
    }
    await fs.writeFile(output, `/** Generated release helpers; reset after building. */\nexport const embeddedCloneHelpers: Record<string, string> = ${JSON.stringify(helpers)};\n`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
