import fs, { type FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { nearestPlaceholder } from "./autohydrate";
import { isGitRepo } from "./git";
import { hydratePlaceholder } from "./hydrate";

/**
 * Negative errnos, as FUSE expects them returned from operation callbacks.
 * Defined locally so this module never has to import the native binding.
 */
export const FUSE_ERRNO = {
  EPERM: -1,
  ENOENT: -2,
  EIO: -5,
  EACCES: -13,
  EROFS: -30,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  EBADF: -9,
} as const;

/** Map a Node fs error (or any error) to the negative errno FUSE wants. */
export function toFuseError(err: unknown): number {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return FUSE_ERRNO.ENOENT;
    case "EACCES":
      return FUSE_ERRNO.EACCES;
    case "ENOTDIR":
      return FUSE_ERRNO.ENOTDIR;
    case "EISDIR":
      return FUSE_ERRNO.EISDIR;
    case "EPERM":
      return FUSE_ERRNO.EPERM;
    case "EROFS":
      return FUSE_ERRNO.EROFS;
    case "EINVAL":
      return FUSE_ERRNO.EINVAL;
    case "EBADF":
      return FUSE_ERRNO.EBADF;
    default:
      return FUSE_ERRNO.EIO;
  }
}

/** The subset of `fs.Stats` fields FUSE reads, as a plain object. */
export interface FuseStat {
  mtime: Date;
  atime: Date;
  ctime: Date;
  nlink: number;
  size: number;
  mode: number;
  uid: number;
  gid: number;
}

export interface OverlayHooks {
  /** Fired once a placeholder has been hydrated on access. */
  onHydrate?(repoDir: string): void;
  onError?(err: Error): void;
}

export interface OverlayOptions {
  /** When true, every mutating operation fails with EROFS. */
  readOnly?: boolean;
}

function errno(code: NodeJS.ErrnoException["code"], message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

/**
 * A read-through overlay over a workspace directory. Most operations pass
 * straight through to the underlying files, but the first access *into* an
 * un-hydrated placeholder triggers a clone-in-place first — so a plain
 * `cat mount/apps/web/package.json` materialises `apps/web` on demand.
 *
 * This is the platform-agnostic "brain": it knows nothing about FUSE and is
 * exercised directly in tests. `createFuseOps` adapts it to the native binding.
 */
export class OverlayFs {
  private readonly root: string;
  private readonly hooks: OverlayHooks;
  private readonly readOnly: boolean;
  /** De-dupes concurrent hydrations of the same placeholder. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Open file handles keyed by their OS file descriptor. */
  private readonly handles = new Map<number, FileHandle>();

  constructor(root: string, hooks: OverlayHooks = {}, options: OverlayOptions = {}) {
    this.root = path.resolve(root);
    this.hooks = hooks;
    this.readOnly = options.readOnly ?? false;
  }

  private assertWritable(): void {
    if (this.readOnly) throw errno("EROFS", "workspace is mounted read-only");
  }

  private handle(fd: number): FileHandle {
    const handle = this.handles.get(fd);
    if (!handle) throw errno("EBADF", `bad file descriptor: ${fd}`);
    return handle;
  }

  /** Translate a mount-relative POSIX path (e.g. `/apps/web`) to a real path. */
  underlying(mountPath: string): string {
    const rel = mountPath.replace(/^[/\\]+/, "");
    const resolved = path.resolve(this.root, rel);
    const rootPrefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    // Never let `..` escape the workspace root.
    if (resolved !== this.root && !resolved.startsWith(rootPrefix)) {
      const err: NodeJS.ErrnoException = new Error(`path escapes workspace: ${mountPath}`);
      err.code = "EACCES";
      throw err;
    }
    return resolved;
  }

  /**
   * If the accessed path lives inside an un-hydrated placeholder, clone it now.
   * Safe to call on every operation: it's a no-op for real repos and plain
   * folders, and concurrent calls share one clone.
   */
  async ensureHydrated(mountPath: string): Promise<void> {
    let underlying: string;
    try {
      underlying = this.underlying(mountPath);
    } catch {
      return; // out-of-root access; the op itself will surface the error
    }

    const target = nearestPlaceholder(underlying, this.root);
    if (!target || isGitRepo(target)) return;

    let job = this.inflight.get(target);
    if (!job) {
      job = hydratePlaceholder(target)
        .then((outcome) => {
          if (outcome !== "already-hydrated") this.hooks.onHydrate?.(target);
        })
        .catch((err: Error) => {
          this.hooks.onError?.(err);
          throw err;
        })
        .finally(() => this.inflight.delete(target));
      this.inflight.set(target, job);
    }
    await job;
  }

  async getattr(mountPath: string): Promise<FuseStat> {
    await this.ensureHydrated(mountPath);
    const s = await fs.lstat(this.underlying(mountPath));
    return {
      mtime: s.mtime,
      atime: s.atime,
      ctime: s.ctime,
      nlink: s.nlink,
      size: s.size,
      mode: s.mode,
      uid: s.uid,
      gid: s.gid,
    };
  }

  async readdir(mountPath: string): Promise<string[]> {
    await this.ensureHydrated(mountPath);
    return fs.readdir(this.underlying(mountPath));
  }

  async readlink(mountPath: string): Promise<string> {
    await this.ensureHydrated(mountPath);
    return fs.readlink(this.underlying(mountPath));
  }

  /**
   * Open with the given POSIX flags (defaults to read-only); returns a real OS
   * file descriptor. Write intent on a read-only mount fails with EROFS.
   */
  async open(mountPath: string, flags: number = fsConstants.O_RDONLY): Promise<number> {
    // O_ACCMODE mask (0o3): O_RDONLY=0, O_WRONLY=1, O_RDWR=2.
    if (this.readOnly && (flags & 0o3) !== fsConstants.O_RDONLY) {
      this.assertWritable();
    }
    await this.ensureHydrated(mountPath);
    const handle = await fs.open(this.underlying(mountPath), flags);
    this.handles.set(handle.fd, handle);
    return handle.fd;
  }

  /** Read into `buffer`; returns the number of bytes read. */
  async read(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
    const { bytesRead } = await this.handle(fd).read(buffer, 0, length, position);
    return bytesRead;
  }

  /** Write `length` bytes from `buffer`; returns the number of bytes written. */
  async write(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
    this.assertWritable();
    const { bytesWritten } = await this.handle(fd).write(buffer, 0, length, position);
    return bytesWritten;
  }

  /** Create (and open) a new file; returns a real OS file descriptor. */
  async create(mountPath: string, mode: number): Promise<number> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    const handle = await fs.open(
      this.underlying(mountPath),
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_TRUNC,
      mode,
    );
    this.handles.set(handle.fd, handle);
    return handle.fd;
  }

  async truncate(mountPath: string, size: number): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.truncate(this.underlying(mountPath), size);
  }

  async ftruncate(fd: number, size: number): Promise<void> {
    this.assertWritable();
    await this.handle(fd).truncate(size);
  }

  async unlink(mountPath: string): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.unlink(this.underlying(mountPath));
  }

  async mkdir(mountPath: string, mode: number): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.mkdir(this.underlying(mountPath), { mode });
  }

  async rmdir(mountPath: string): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.rmdir(this.underlying(mountPath));
  }

  async rename(srcPath: string, destPath: string): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(srcPath);
    await this.ensureHydrated(destPath);
    await fs.rename(this.underlying(srcPath), this.underlying(destPath));
  }

  async chmod(mountPath: string, mode: number): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.chmod(this.underlying(mountPath), mode);
  }

  async chown(mountPath: string, uid: number, gid: number): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.chown(this.underlying(mountPath), uid, gid);
  }

  async utimens(mountPath: string, atime: Date | number, mtime: Date | number): Promise<void> {
    this.assertWritable();
    await this.ensureHydrated(mountPath);
    await fs.utimes(this.underlying(mountPath), atime, mtime);
  }

  async fsync(fd: number, dataSync: boolean): Promise<void> {
    const handle = this.handle(fd);
    if (dataSync) await handle.datasync();
    else await handle.sync();
  }

  async release(fd: number): Promise<void> {
    const handle = this.handles.get(fd);
    if (handle) {
      this.handles.delete(fd);
      await handle.close();
    }
  }
}

/* ------------------------------------------------------------------ *
 * FUSE adapter                                                        *
 * ------------------------------------------------------------------ */

type Callback0 = (code: number) => void;
type CallbackStat = (code: number, stat?: FuseStat) => void;
type CallbackNames = (code: number, names?: string[]) => void;
type CallbackFd = (code: number, fd?: number) => void;
type CallbackLink = (code: number, link?: string) => void;
type CallbackRead = (bytesOrError: number) => void;

export interface FuseOperations {
  init(cb: Callback0): void;
  getattr(mountPath: string, cb: CallbackStat): void;
  readdir(mountPath: string, cb: CallbackNames): void;
  readlink(mountPath: string, cb: CallbackLink): void;
  open(mountPath: string, flags: number, cb: CallbackFd): void;
  read(
    mountPath: string,
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: CallbackRead,
  ): void;
  write(
    mountPath: string,
    fd: number,
    buffer: Buffer,
    length: number,
    position: number,
    cb: CallbackRead,
  ): void;
  create(mountPath: string, mode: number, cb: CallbackFd): void;
  truncate(mountPath: string, size: number, cb: Callback0): void;
  ftruncate(mountPath: string, fd: number, size: number, cb: Callback0): void;
  unlink(mountPath: string, cb: Callback0): void;
  mkdir(mountPath: string, mode: number, cb: Callback0): void;
  rmdir(mountPath: string, cb: Callback0): void;
  rename(srcPath: string, destPath: string, cb: Callback0): void;
  chmod(mountPath: string, mode: number, cb: Callback0): void;
  chown(mountPath: string, uid: number, gid: number, cb: Callback0): void;
  utimens(mountPath: string, atime: Date | number, mtime: Date | number, cb: Callback0): void;
  flush(mountPath: string, fd: number, cb: Callback0): void;
  fsync(mountPath: string, fd: number, dataSync: boolean, cb: Callback0): void;
  release(mountPath: string, fd: number, cb: Callback0): void;
}

/**
 * Adapt an `OverlayFs` to the callback-style operations table `fuse-native`
 * expects. Kept thin and free of the native binding so it is unit-testable.
 */
export function createFuseOps(overlay: OverlayFs): FuseOperations {
  return {
    init(cb) {
      cb(0);
    },
    getattr(mountPath, cb) {
      overlay.getattr(mountPath).then(
        (stat) => cb(0, stat),
        (err) => cb(toFuseError(err)),
      );
    },
    readdir(mountPath, cb) {
      overlay.readdir(mountPath).then(
        (names) => cb(0, names),
        (err) => cb(toFuseError(err)),
      );
    },
    readlink(mountPath, cb) {
      overlay.readlink(mountPath).then(
        (link) => cb(0, link),
        (err) => cb(toFuseError(err)),
      );
    },
    open(mountPath, flags, cb) {
      overlay.open(mountPath, flags).then(
        (fd) => cb(0, fd),
        (err) => cb(toFuseError(err)),
      );
    },
    read(_mountPath, fd, buffer, length, position, cb) {
      overlay.read(fd, buffer, length, position).then(
        (bytes) => cb(bytes),
        (err) => cb(toFuseError(err)),
      );
    },
    write(_mountPath, fd, buffer, length, position, cb) {
      overlay.write(fd, buffer, length, position).then(
        (bytes) => cb(bytes),
        (err) => cb(toFuseError(err)),
      );
    },
    create(mountPath, mode, cb) {
      overlay.create(mountPath, mode).then(
        (fd) => cb(0, fd),
        (err) => cb(toFuseError(err)),
      );
    },
    truncate(mountPath, size, cb) {
      overlay.truncate(mountPath, size).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    ftruncate(_mountPath, fd, size, cb) {
      overlay.ftruncate(fd, size).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    unlink(mountPath, cb) {
      overlay.unlink(mountPath).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    mkdir(mountPath, mode, cb) {
      overlay.mkdir(mountPath, mode).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    rmdir(mountPath, cb) {
      overlay.rmdir(mountPath).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    rename(srcPath, destPath, cb) {
      overlay.rename(srcPath, destPath).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    chmod(mountPath, mode, cb) {
      overlay.chmod(mountPath, mode).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    chown(mountPath, uid, gid, cb) {
      overlay.chown(mountPath, uid, gid).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    utimens(mountPath, atime, mtime, cb) {
      overlay.utimens(mountPath, atime, mtime).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    flush(_mountPath, _fd, cb) {
      cb(0);
    },
    fsync(_mountPath, fd, dataSync, cb) {
      overlay.fsync(fd, dataSync).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
    release(_mountPath, fd, cb) {
      overlay.release(fd).then(
        () => cb(0),
        (err) => cb(toFuseError(err)),
      );
    },
  };
}
