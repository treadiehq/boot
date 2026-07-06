import { execa } from "execa";

/**
 * GitHub-specific helpers that smooth onboarding: when a map remote doesn't
 * exist yet, boot can offer to create it via the GitHub CLI (`gh`) instead of
 * sending the user to a browser. Pure logic — prompting and printing stay in
 * the command layer.
 */

/** Extract "owner/repo" from a GitHub remote URL (scp, ssh://, or https). Null for other hosts. */
export function parseGitHubSlug(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const patterns = [
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@(?:ssh\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const match = url.match(re);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

/**
 * Whether a failed remote probe means "the repo doesn't exist" — as opposed to
 * an auth or network problem, which creating a repo would not fix. Covers the
 * phrasing GitHub, GitLab, and Bitbucket use.
 */
export function isRepoNotFoundError(detail: string): boolean {
  return /not found|does not exist|could not be found/i.test(detail);
}

/** Whether the GitHub CLI is installed and runnable. */
export async function ghAvailable(): Promise<boolean> {
  try {
    const res = await execa("gh", ["--version"], { reject: false });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/** Create a private GitHub repo with `gh repo create`. Throws with gh's message on failure. */
export async function ghCreatePrivateRepo(slug: string): Promise<void> {
  let res;
  try {
    res = await execa("gh", ["repo", "create", slug, "--private"], { reject: false });
  } catch (err) {
    throw new Error(`gh repo create failed: ${(err as Error).message}`);
  }
  if (res.exitCode !== 0) {
    throw new Error(`gh repo create failed: ${String(res.stderr || res.stdout).trim()}`);
  }
}
