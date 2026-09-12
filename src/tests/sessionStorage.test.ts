import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

// Re-import copyTree with the native clone helpers mocked, so the Windows and
// macOS native branches are exercisable on any host. FSCTL_DUPLICATE_EXTENTS_TO_FILE
// copies data extents only, never file attributes, so the mock creates a writable
// destination (FILE_ATTRIBUTE_NORMAL) without preserving the source mode.
async function importCopyTree(clone: { windows?: (files: Array<{ source: string; destination: string }>) => Promise<unknown>; mac?: (files: Array<{ source: string; destination: string }>) => Promise<unknown> }) {
  vi.doMock("../core/sessionWindows", () => ({ windowsCloneFiles: clone.windows ?? (async () => {}) }));
  vi.doMock("../core/sessionNative", () => ({ macCloneFiles: clone.mac ?? (async () => {}) }));
  vi.resetModules();
  return await import("../core/sessionStorage");
}

// Simulate the Windows native ReFS clone: data extents duplicated, but the
// destination is created writable (FILE_ATTRIBUTE_NORMAL) and file attributes
// are not copied. readFile+writeFile(0o666) avoids fs.copyFile, which on Linux
// preserves the source mode and would mask the bug.
async function fakeWindowsClone(files: Array<{ source: string; destination: string }>): Promise<void> {
  for (const { source, destination } of files) {
    const content = await fs.readFile(source);
    await fs.writeFile(destination, content, { mode: 0o666 });
  }
}

const workspaceRoot = () => process.env.BOOT_TEST_WORKSPACE_ROOT ?? os.tmpdir();
const mode = (p: string) => fs.stat(p).then((s) => s.mode & 0o777);

// Mode restoration is intentionally symmetric on the copy and Windows native
// CoW branches, and intentionally absent on the macOS native branch (clonefile(2)
// preserves the source mode natively). These guard that invariant.
describe("copyTree mode restoration across CoW backends", () => {
  let root: string;

  beforeEach(async () => { root = await fs.mkdtemp(path.join(workspaceRoot(), "boot-copytree-mode-")); });
  afterEach(async () => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.doUnmock("../core/sessionWindows");
    vi.doUnmock("../core/sessionNative");
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("restores a read-only source mode after the Windows native ReFS clone", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { copyTree } = await importCopyTree({ windows: fakeWindowsClone });
    const source = path.join(root, "readonly");
    const destination = path.join(root, "clone");
    await fs.writeFile(source, "read-only\n", { mode: 0o444 });
    await copyTree(source, destination, true);
    expect(await mode(destination)).toBe(await mode(source));
    expect((await mode(destination)) & 0o200).toBe(0); // owner-write bit stays clear = read-only
  });

  it("leaves macOS native cloning in charge of mode preservation (no compensating chmod)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    let called = false;
    const { copyTree } = await importCopyTree({
      mac: async (files) => {
        called = true;
        // clonefile(2) preserves the source mode natively; the mock deliberately
        // creates a writable destination so that a compensating chmod added by
        // copyTree to the macOS branch would be observable as read-only.
        await fakeWindowsClone(files);
      },
    });
    const source = path.join(root, "src"), destination = path.join(root, "dst");
    await fs.writeFile(source, "read-only\n", { mode: 0o444 });
    await copyTree(source, destination, true);
    expect(called).toBe(true);
    expect((await mode(destination)) & 0o200).not.toBe(0); // copyTree does not chmod on macOS
  });

  it("still preserves mode on the non-CoW full-copy path", async () => {
    Object.defineProperty(process, "platform", originalPlatform); // native platform
    const { copyTree } = await importCopyTree({});
    const source = path.join(root, "src"), destination = path.join(root, "dst");
    await fs.writeFile(source, "read-only\n", { mode: 0o444 });
    await copyTree(source, destination, false);
    expect(await mode(destination)).toBe(await mode(source));
    expect((await mode(destination)) & 0o200).toBe(0);
  });
});
