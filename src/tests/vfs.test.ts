import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import {
  createFuseOps,
  FUSE_ERRNO,
  OverlayFs,
  toFuseError,
  type FuseStat,
} from "../core/vfs";
import { buildPlaceholderMeta, isPlaceholder, writePlaceholder } from "../core/placeholder";
import { isGitRepo } from "../core/git";

function gitUsable(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(path.join(os.tmpdir(), "boot-gitprobe-"));
    execFileSync("git", ["init", "-q"], { cwd: probe, stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

const GIT_OK = gitUsable();

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-vfs-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function makePlaceholder(rel: string, remoteUrl: string | null): Promise<string> {
  const repoDir = path.join(root, rel);
  await fs.mkdir(repoDir, { recursive: true });
  await writePlaceholder(
    repoDir,
    buildPlaceholderMeta({
      name: path.basename(rel),
      relativePath: rel,
      remoteUrl,
      currentBranch: "main",
      lastCommit: "abc123",
    }),
  );
  return repoDir;
}

async function seedRemote(name: string): Promise<string> {
  const pub = path.join(root, `${name}-pub`);
  await fs.mkdir(pub, { recursive: true });
  git(pub, "init", "-q", "-b", "main");
  git(pub, "config", "user.email", "t@t.test");
  git(pub, "config", "user.name", "tester");
  await fs.writeFile(path.join(pub, "package.json"), '{"name":"web"}\n');
  await fs.writeFile(path.join(pub, "README.md"), "# web\n");
  git(pub, "add", "-A");
  git(pub, "commit", "-q", "-m", "init");
  const remote = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "pipe" });
  git(pub, "remote", "add", "origin", remote);
  git(pub, "push", "-q", "origin", "main");
  execFileSync("git", ["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "pipe" });
  return remote;
}

describe("toFuseError", () => {
  it("maps known fs error codes to negative errnos", () => {
    expect(toFuseError(Object.assign(new Error(), { code: "ENOENT" }))).toBe(FUSE_ERRNO.ENOENT);
    expect(toFuseError(Object.assign(new Error(), { code: "EACCES" }))).toBe(FUSE_ERRNO.EACCES);
    expect(toFuseError(Object.assign(new Error(), { code: "ENOTDIR" }))).toBe(FUSE_ERRNO.ENOTDIR);
    expect(toFuseError(Object.assign(new Error(), { code: "EBADF" }))).toBe(FUSE_ERRNO.EBADF);
    expect(toFuseError(Object.assign(new Error(), { code: "EROFS" }))).toBe(FUSE_ERRNO.EROFS);
  });

  it("falls back to EIO for unknown errors", () => {
    expect(toFuseError(new Error("boom"))).toBe(FUSE_ERRNO.EIO);
  });
});

describe("OverlayFs.underlying", () => {
  it("maps mount-relative paths under the root", () => {
    const overlay = new OverlayFs(root);
    expect(overlay.underlying("/")).toBe(path.resolve(root));
    expect(overlay.underlying("/apps/web")).toBe(path.resolve(root, "apps/web"));
  });

  it("accepts valid paths when the workspace is the filesystem root", () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    const overlay = new OverlayFs(filesystemRoot);
    expect(overlay.underlying("/boot-root-mount-test")).toBe(
      path.resolve(filesystemRoot, "boot-root-mount-test"),
    );
  });

  it("rejects paths that escape the workspace root", () => {
    const overlay = new OverlayFs(root);
    expect(() => overlay.underlying("/../../etc/passwd")).toThrow(/escapes workspace/);
  });
});

describe("createFuseOps", () => {
  function fakeOverlay(overrides: Partial<Record<string, unknown>>): OverlayFs {
    return overrides as unknown as OverlayFs;
  }

  it("init replies success", () => {
    const ops = createFuseOps(fakeOverlay({}));
    const cb = vi.fn();
    ops.init(cb);
    expect(cb).toHaveBeenCalledWith(0);
  });

  it("getattr forwards the stat on success", async () => {
    const stat: FuseStat = {
      mtime: new Date(),
      atime: new Date(),
      ctime: new Date(),
      nlink: 1,
      size: 10,
      mode: 0o100644,
      uid: 0,
      gid: 0,
    };
    const ops = createFuseOps(fakeOverlay({ getattr: () => Promise.resolve(stat) }));
    const cb = vi.fn();
    ops.getattr("/x", cb);
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledWith(0, stat);
  });

  it("getattr maps a missing file to ENOENT", async () => {
    const ops = createFuseOps(
      fakeOverlay({ getattr: () => Promise.reject(Object.assign(new Error(), { code: "ENOENT" })) }),
    );
    const cb = vi.fn();
    ops.getattr("/missing", cb);
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledWith(FUSE_ERRNO.ENOENT);
  });

  it("read replies with the byte count", async () => {
    const ops = createFuseOps(fakeOverlay({ read: () => Promise.resolve(7) }));
    const cb = vi.fn();
    ops.read("/x", 3, Buffer.alloc(7), 7, 0, cb);
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledWith(7);
  });

  it("maps a read-only create failure to EROFS", async () => {
    const error = Object.assign(new Error("workspace is mounted read-only"), { code: "EROFS" });
    const ops = createFuseOps(fakeOverlay({ create: () => Promise.reject(error) }));
    const cb = vi.fn();
    ops.create("/new.txt", 0o644, cb);
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledWith(FUSE_ERRNO.EROFS);
  });
});

describe.skipIf(!GIT_OK)("OverlayFs hydrate-on-read (e2e)", () => {
  it("materialises a placeholder when a file inside it is stat-ed", async () => {
    const remote = await seedRemote("web");
    const dir = await makePlaceholder("apps/web", remote);

    const hydrated: string[] = [];
    const overlay = new OverlayFs(root, { onHydrate: (d) => hydrated.push(d) });

    // The file doesn't exist on disk yet — only the .boot/ placeholder does.
    expect(existsSync(path.join(dir, "package.json"))).toBe(false);

    const stat = await overlay.getattr("/apps/web/package.json");
    expect(stat.size).toBeGreaterThan(0);

    // The whole repo materialised in place, .boot/ preserved.
    expect(isGitRepo(dir)).toBe(true);
    expect(isPlaceholder(dir)).toBe(true);
    expect(hydrated).toEqual([path.resolve(dir)]);
  });

  it("reads file contents through open/read/release", async () => {
    const remote = await seedRemote("web");
    const dir = await makePlaceholder("apps/web", remote);
    const overlay = new OverlayFs(root);

    const fd = await overlay.open("/apps/web/package.json");
    const buf = Buffer.alloc(64);
    const bytes = await overlay.read(fd, buf, 64, 0);
    await overlay.release(fd);

    // Normalise CRLF: git's core.autocrlf may rewrite line endings on checkout.
    const contents = buf.subarray(0, bytes).toString("utf8").replace(/\r\n/g, "\n");
    expect(contents).toBe('{"name":"web"}\n');
    expect(isGitRepo(dir)).toBe(true);
  });

  it("readdir lists the hydrated contents", async () => {
    const remote = await seedRemote("web");
    await makePlaceholder("apps/web", remote);
    const overlay = new OverlayFs(root);

    const names = await overlay.readdir("/apps/web");
    expect(names).toContain("package.json");
    expect(names).toContain("README.md");
  });

  it("does not hydrate plain folders", async () => {
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes", "todo.txt"), "hi\n");
    const hydrated: string[] = [];
    const overlay = new OverlayFs(root, { onHydrate: (d) => hydrated.push(d) });

    const stat = await overlay.getattr("/notes/todo.txt");
    expect(stat.size).toBe(3);
    expect(hydrated).toEqual([]);
  });
});

describe("OverlayFs read-write passthrough", () => {
  it("creates, writes, and reads a file back", async () => {
    const overlay = new OverlayFs(root);
    const fd = await overlay.create("/hello.txt", 0o644);
    const written = await overlay.write(fd, Buffer.from("hello world"), 11, 0);
    await overlay.release(fd);

    expect(written).toBe(11);
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("hello world");
  });

  it("truncates a file", async () => {
    await fs.writeFile(path.join(root, "f.txt"), "abcdef");
    const overlay = new OverlayFs(root);
    await overlay.truncate("/f.txt", 3);
    expect(await fs.readFile(path.join(root, "f.txt"), "utf8")).toBe("abc");
  });

  it("unlinks a file", async () => {
    await fs.writeFile(path.join(root, "gone.txt"), "x");
    const overlay = new OverlayFs(root);
    await overlay.unlink("/gone.txt");
    expect(existsSync(path.join(root, "gone.txt"))).toBe(false);
  });

  it("makes and removes directories", async () => {
    const overlay = new OverlayFs(root);
    await overlay.mkdir("/d", 0o755);
    expect(existsSync(path.join(root, "d"))).toBe(true);
    await overlay.rmdir("/d");
    expect(existsSync(path.join(root, "d"))).toBe(false);
  });

  it("renames a file", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "data");
    const overlay = new OverlayFs(root);
    await overlay.rename("/a.txt", "/b.txt");
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("data");
  });
});

describe("OverlayFs read-only mode", () => {
  it("rejects every mutating operation with EROFS", async () => {
    await fs.writeFile(path.join(root, "f.txt"), "x");
    const overlay = new OverlayFs(root, {}, { readOnly: true });

    await expect(overlay.create("/new.txt", 0o644)).rejects.toMatchObject({ code: "EROFS" });
    await expect(overlay.unlink("/f.txt")).rejects.toMatchObject({ code: "EROFS" });
    await expect(overlay.mkdir("/d", 0o755)).rejects.toMatchObject({ code: "EROFS" });
    await expect(overlay.truncate("/f.txt", 0)).rejects.toMatchObject({ code: "EROFS" });
    await expect(overlay.open("/f.txt", fsConstants.O_WRONLY)).rejects.toMatchObject({
      code: "EROFS",
    });
  });

  it("still allows reads", async () => {
    await fs.writeFile(path.join(root, "f.txt"), "readme");
    const overlay = new OverlayFs(root, {}, { readOnly: true });
    const fd = await overlay.open("/f.txt");
    const buf = Buffer.alloc(6);
    const n = await overlay.read(fd, buf, 6, 0);
    await overlay.release(fd);
    expect(buf.subarray(0, n).toString("utf8")).toBe("readme");
  });
});
