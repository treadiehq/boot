import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execa } from "execa";
import { stateDir } from "./identity";
import { withFileLock } from "./lock";
import { embeddedCloneHelpers } from "./sessionNativeEmbedded";

// One small native primitive, no filesystem implementation. NUL-delimited
// pairs preserve every valid POSIX filename and avoid argument-size limits.
export const MAC_CLONE_SOURCE = String.raw`
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
int main(void) {
  char *source = NULL, *target = NULL;
  size_t source_size = 0, target_size = 0;
  ssize_t count;
  unsigned long index = 0;
  while ((count = getdelim(&source, &source_size, 0, stdin)) != -1) {
    if (count < 2 || source[count - 1] != 0) return 2;
    count = getdelim(&target, &target_size, 0, stdin);
    if (count < 2 || target[count - 1] != 0) return 2;
    struct stat info;
    if (lstat(source, &info) != 0 || !S_ISREG(info.st_mode)) {
      printf("%d %lu\n", EINVAL, index); return 1;
    }
    if (clonefile(source, target, CLONE_NOFOLLOW) != 0) {
      printf("%d %lu\n", errno, index); return 1;
    }
    index++;
  }
  free(source); free(target);
  return ferror(stdin) ? 2 : 0;
}
`;

async function helperPath(): Promise<string> {
  const embedded = embeddedCloneHelpers[process.arch];
  const digest = createHash("sha256").update(embedded ?? MAC_CLONE_SOURCE).digest("hex").slice(0, 24);
  const directory = path.join(stateDir(), "native");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error("Native helper cache ownership is unsafe.");
  const target = path.join(directory, `clonefile-${process.arch}-${digest}`);
  return withFileLock(`${target}.lock`, "preparing the native clonefile helper", async () => {
    const existing = await fs.lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) {
      if (!existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o022)) throw new Error("Native helper ownership is unsafe.");
      return target;
    }
    const temporary = `${target}.${randomUUID()}`;
    try {
      if (embedded) {
        await fs.writeFile(temporary, Buffer.from(embedded, "base64"), { mode: 0o700, flag: "wx" });
      } else {
        // Source/npm runs need Apple's compiler once; standalone macOS
        // releases embed both architectures and do not require a compiler.
        const available = await execa("/usr/bin/xcode-select", ["-p"], { reject: false });
        if (available.exitCode !== 0) throw Object.assign(new Error("APFS cloning requires the bundled native helper or installed Apple command line tools."), { code: "EHELPERUNAVAILABLE" });
        await fs.writeFile(`${temporary}.c`, MAC_CLONE_SOURCE, { mode: 0o600, flag: "wx" });
        const compile = await execa("/usr/bin/clang", ["-O2", "-Wall", "-Werror", `${temporary}.c`, "-o", temporary], { reject: false });
        if (compile.exitCode !== 0) throw Object.assign(new Error("Could not compile Boot's native clonefile helper. Use a standalone macOS release or repair Apple command line tools."), { code: "EHELPERBUILD" });
        await fs.chmod(temporary, 0o700);
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(`${temporary}.c`, { force: true });
      await fs.rm(temporary, { force: true });
    }
    return target;
  }, { staleAfterMs: 1000 });
}

export async function macCloneFiles(files: Array<{ source: string; destination: string }>): Promise<void> {
  if (!files.length) return;
  const helper = await helperPath();
  const result = await execa(helper, [], { input: files.map(({ source, destination }) => `${source}\0${destination}\0`).join(""), reject: false });
  if (result.exitCode !== 0) {
    const errno = Number(result.stdout.split(" ")[0]);
    const code = Object.entries(os.constants.errno).find(([, value]) => value === errno)?.[0] ?? "ECLONE";
    throw Object.assign(new Error(`Native clonefile failed (${code}); no full-copy fallback was used.`), { code });
  }
}
