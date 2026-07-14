import { execa } from "execa";
import { quoteUserValue, subprocessFailureReason } from "./userErrors";

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
  const repoNotFoundPatterns = [
    /^(?:(?:ERROR|remote):\s*)?Repository not found\.?\s*$/im,
    /^remote:\s+.*\bproject\b.*\bcould not be found\b.*$/im,
    /^(?:fatal:\s+)?repository\b.*\bdoes not exist\.?\s*$/im,
    /^fatal:\s+repository\b.*\bnot found\.?\s*$/im,
  ];
  return repoNotFoundPatterns.some((pattern) => pattern.test(detail));
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

/** Create a private GitHub repo with `gh repo create`. */
export async function ghCreatePrivateRepo(slug: string): Promise<void> {
  let res;
  try {
    res = await execa("gh", ["repo", "create", slug, "--private"], {
      reject: false,
      stdin: "ignore",
      timeout: 120_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        "GitHub CLI was not found. Install `gh`, sign in with `gh auth login`, then retry.",
      );
    }
    const reason = subprocessFailureReason((err as Error).message);
    throw new Error(
      `Could not create GitHub repository ${quoteUserValue(slug)}.` +
        (reason ? ` Reason: ${reason.replace(/[.!?]+$/, "")}.` : "") +
        " Run `gh auth status`, fix the reported access problem, then retry.",
    );
  }
  if (res.exitCode !== 0) {
    const reason = subprocessFailureReason(res.stderr || res.stdout);
    throw new Error(
      `Could not create GitHub repository ${quoteUserValue(slug)}.` +
        (reason ? ` Reason: ${reason.replace(/[.!?]+$/, "")}.` : "") +
        " Run `gh auth status`, fix the reported access problem, then retry.",
    );
  }
}
