import { execa, type Options } from "execa";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Thin wrapper around the `git` binary using execa.
 * Read helpers never throw (they return null/false on failure) so a single bad
 * repo can't abort a whole scan; mutating helpers throw with useful messages.
 */
async function git(args: string[], opts: Options = {}) {
  return execa("git", args, { reject: false, ...opts });
}

/** Throw a friendly error if git is not installed / not on PATH. */
export async function ensureGitAvailable(): Promise<void> {
  try {
    const res = await git(["--version"]);
    if (res.exitCode === 0) return;
  } catch {
    // fall through to the thrown error below
  }
  throw new Error(
    "Git was not found on this machine. Install Git and make sure `git` is on your PATH.",
  );
}

/** A directory is a git repo if it contains a `.git` entry (dir for clones, file for worktrees). */
export function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

export async function getRemoteUrl(dir: string): Promise<string | null> {
  const res = await git(["-C", dir, "remote", "get-url", "origin"]);
  if (res.exitCode !== 0) return null;
  const url = String(res.stdout).trim();
  return url.length > 0 ? url : null;
}

export async function getCurrentBranch(dir: string): Promise<string | null> {
  const res = await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.exitCode !== 0) return null;
  const branch = String(res.stdout).trim();
  // "HEAD" means detached HEAD or a repo with no commits yet.
  if (!branch || branch === "HEAD") return null;
  return branch;
}

export async function isDirty(dir: string): Promise<boolean> {
  const res = await git(["-C", dir, "status", "--porcelain"]);
  if (res.exitCode !== 0) return false;
  return String(res.stdout).trim().length > 0;
}

export async function getLastCommit(dir: string): Promise<string | null> {
  const res = await git(["-C", dir, "rev-parse", "HEAD"]);
  if (res.exitCode !== 0) return null;
  const sha = String(res.stdout).trim();
  return sha.length > 0 ? sha : null;
}

/** Committer date of HEAD as a Date, or null if unavailable. */
export async function getLastCommitDate(dir: string): Promise<Date | null> {
  const res = await git(["-C", dir, "log", "-1", "--format=%cI"]);
  if (res.exitCode !== 0) return null;
  const iso = String(res.stdout).trim();
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Probe whether a remote URL exists and is reachable, without cloning.
 * Returns git's error detail when it isn't, so callers can tell "repo doesn't
 * exist" apart from auth/network failures.
 */
export async function gitRemoteProbe(
  remoteUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  // Never let the probe block on an interactive credential prompt — credential
  // helpers still run; only terminal prompting is disabled.
  const res = await git(["ls-remote", remoteUrl, "HEAD"], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: res.exitCode === 0, detail: String(res.stderr || res.stdout).trim() };
}

export async function cloneRepo(remoteUrl: string, targetPath: string): Promise<void> {
  const res = await git(["clone", remoteUrl, targetPath]);
  if (res.exitCode !== 0) {
    const detail = String(res.stderr || res.stdout).trim();
    throw new Error(`git clone failed for ${remoteUrl}${detail ? `: ${detail}` : ""}`);
  }
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const res = await git(["-C", repoPath, "checkout", branch]);
  if (res.exitCode !== 0) {
    const detail = String(res.stderr || res.stdout).trim();
    throw new Error(`git checkout ${branch} failed${detail ? `: ${detail}` : ""}`);
  }
}

/* ------------------------------------------------------------------ *
 * Map-repo helpers — used by the sync transport to manage the small  *
 * git repository that carries the workspace map between machines.    *
 * ------------------------------------------------------------------ */

/** Porcelain status output for a repo (empty string when clean or on error). */
export async function gitStatusPorcelain(dir: string): Promise<string> {
  const res = await git(["-C", dir, "status", "--porcelain"]);
  return res.exitCode === 0 ? String(res.stdout) : "";
}

async function gitAddAll(dir: string): Promise<void> {
  const res = await git(["-C", dir, "add", "-A"]);
  if (res.exitCode !== 0) {
    throw new Error(`git add failed: ${String(res.stderr || res.stdout).trim()}`);
  }
}

/**
 * Current branch name, falling back to "main" for an unborn branch. Use
 * `git symbolic-ref` so it works even before the first commit exists.
 */
export async function gitCurrentBranchName(dir: string): Promise<string> {
  const res = await git(["-C", dir, "symbolic-ref", "--short", "HEAD"]);
  const name = String(res.stdout).trim();
  return name.length > 0 ? name : "main";
}

/**
 * Stage everything and commit with boot's own bookkeeping identity (the map
 * repo is generated state, not the user's project history, so we never depend
 * on — or touch — their global git config). Returns false when there is
 * nothing to commit.
 */
export async function gitCommitAll(dir: string, message: string): Promise<boolean> {
  await gitAddAll(dir);
  if ((await gitStatusPorcelain(dir)).trim().length === 0) return false;
  const res = await git([
    "-C",
    dir,
    "-c",
    "user.name=boot",
    "-c",
    "user.email=boot@localhost",
    "commit",
    "-m",
    message,
  ]);
  if (res.exitCode !== 0) {
    throw new Error(`git commit failed: ${String(res.stderr || res.stdout).trim()}`);
  }
  return true;
}

/** Whether HEAD has commits the remote does not (true when there is no upstream yet). */
export async function gitHasUnpushed(dir: string): Promise<boolean> {
  const upstream = await git([
    "-C",
    dir,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (upstream.exitCode !== 0) {
    // No upstream configured yet — anything we have committed needs pushing.
    const head = await git(["-C", dir, "rev-parse", "HEAD"]);
    return head.exitCode === 0;
  }
  const res = await git(["-C", dir, "rev-list", "--count", "@{u}..HEAD"]);
  return Number.parseInt(String(res.stdout).trim() || "0", 10) > 0;
}

/** Pull with rebase. Tolerates an empty remote / missing upstream; throws on real conflicts. */
export async function gitPullRebase(dir: string): Promise<void> {
  const res = await git(["-C", dir, "pull", "--rebase", "--autostash"]);
  if (res.exitCode === 0) return;
  const detail = String(res.stderr || res.stdout);
  const benign =
    /no tracking information|did not specify a branch|couldn't find remote ref|no such ref|empty repository|unknown revision|ambiguous argument|does not appear to be a git repository/i;
  if (benign.test(detail)) return;
  throw new Error(`git pull failed: ${detail.trim()}`);
}

/** Push the current branch, setting upstream on first push. */
export async function gitPush(dir: string): Promise<void> {
  const branch = await gitCurrentBranchName(dir);
  const res = await git(["-C", dir, "push", "-u", "origin", branch]);
  if (res.exitCode !== 0) {
    throw new Error(`git push failed: ${String(res.stderr || res.stdout).trim()}`);
  }
}

/* ------------------------------------------------------------------ *
 * Freshness helpers — used by the daemon to keep hydrated repos in    *
 * step with their remotes (the cure for "built on a stale main").     *
 * ------------------------------------------------------------------ */

/** Fetch updates for a repo. Returns false on failure (e.g. offline) rather than throwing. */
export async function gitFetch(dir: string): Promise<boolean> {
  const res = await git(["-C", dir, "fetch", "--quiet"]);
  return res.exitCode === 0;
}

/** Upstream tracking ref of the current branch (e.g. "origin/main"), or null when unset. */
export async function gitUpstreamRef(dir: string): Promise<string | null> {
  const res = await git(["-C", dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (res.exitCode !== 0) return null;
  const ref = String(res.stdout).trim();
  return ref.length > 0 ? ref : null;
}

export interface AheadBehind {
  /** Commits the upstream has that HEAD does not. */
  behind: number;
  /** Commits HEAD has that the upstream does not. */
  ahead: number;
}

/** Count how far HEAD is ahead of / behind its upstream. Null when there is no upstream. */
export async function gitAheadBehind(dir: string): Promise<AheadBehind | null> {
  const res = await git(["-C", dir, "rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (res.exitCode !== 0) return null;
  const [left, right] = String(res.stdout).trim().split(/\s+/);
  const behind = Number.parseInt(left ?? "0", 10);
  const ahead = Number.parseInt(right ?? "0", 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return null;
  return { behind, ahead };
}

/** Fast-forward the current branch to its upstream. Returns false when a ff is not possible. */
export async function gitFastForwardOnly(dir: string): Promise<boolean> {
  const res = await git(["-C", dir, "merge", "--ff-only", "@{u}"]);
  return res.exitCode === 0;
}
