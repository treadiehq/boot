import { it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";

it("packages signed APFS helpers for both architectures and runs the native bytes", async (context) => {
  if (process.platform !== "darwin") { context.skip("macOS release helper"); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "boot-native-release-test-"));
  try {
    const output = path.join(directory, "embedded.ts");
    await execa(process.execPath, ["scripts/embed-session-native.mjs", "--output", output]);
    const helpers = JSON.parse((await fs.readFile(output, "utf8")).match(/= (\{.*\});/)![1]!);
    expect(Object.keys(helpers).sort()).toEqual(["arm64", "x64"]);
    for (const architecture of Object.keys(helpers)) {
      const binary = path.join(directory, architecture);
      await fs.writeFile(binary, Buffer.from(helpers[architecture], "base64"), { mode: 0o700 });
      await execa("/usr/bin/codesign", ["--verify", "--strict", binary]);
    }
    const source = path.join(directory, "source"), target = path.join(directory, "target");
    await fs.writeFile(source, "original\n");
    await execa(path.join(directory, process.arch), [], { input: `${source}\0${target}\0` });
    expect((await fs.stat(target)).ino).not.toBe((await fs.stat(source)).ino);
    await fs.writeFile(target, "edited\n");
    expect(await fs.readFile(source, "utf8")).toBe("original\n");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}, 30_000);
