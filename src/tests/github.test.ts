import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/git")>();
  return { ...actual, gitRemoteProbe: vi.fn() };
});
vi.mock("../core/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/github")>();
  return { ...actual, ghAvailable: vi.fn(), ghCreatePrivateRepo: vi.fn() };
});
vi.mock("../ui/prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/prompt")>();
  return { ...actual, isInteractive: vi.fn(() => false), confirm: vi.fn() };
});

import { gitRemoteProbe } from "../core/git";
import { ghAvailable, ghCreatePrivateRepo, isRepoNotFoundError, parseGitHubSlug } from "../core/github";
import { confirm, isInteractive } from "../ui/prompt";
import { ensureMapRemoteExists } from "../commands/link";

const probeMock = vi.mocked(gitRemoteProbe);
const ghAvailableMock = vi.mocked(ghAvailable);
const ghCreateMock = vi.mocked(ghCreatePrivateRepo);
const confirmMock = vi.mocked(confirm);
const interactiveMock = vi.mocked(isInteractive);

describe("parseGitHubSlug", () => {
  it("parses scp-style, ssh, and https GitHub URLs", () => {
    expect(parseGitHubSlug("git@github.com:me/code-map.git")).toBe("me/code-map");
    expect(parseGitHubSlug("git@github.com:me/code-map")).toBe("me/code-map");
    expect(parseGitHubSlug("ssh://git@github.com/me/code-map.git")).toBe("me/code-map");
    expect(parseGitHubSlug("ssh://git@github.com:22/me/code-map.git")).toBe("me/code-map");
    expect(parseGitHubSlug("ssh://git@ssh.github.com:443/me/code-map.git")).toBe("me/code-map");
    expect(parseGitHubSlug("https://github.com/me/code-map")).toBe("me/code-map");
    expect(parseGitHubSlug("https://github.com/me/code-map.git")).toBe("me/code-map");
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubSlug("git@gitlab.com:me/code-map.git")).toBeNull();
    expect(parseGitHubSlug("https://bitbucket.org/me/code-map")).toBeNull();
    expect(parseGitHubSlug("/some/local/path")).toBeNull();
  });

  it("returns null for GitHub web URLs with extra path components", () => {
    expect(parseGitHubSlug("https://github.com/me/code-map/tree/main")).toBeNull();
    expect(parseGitHubSlug("https://github.com/me/code-map/issues/123")).toBeNull();
    expect(parseGitHubSlug("https://github.com/me/code-map/pull/456")).toBeNull();
    expect(parseGitHubSlug("https://github.com/me/code-map/blob/main/README.md")).toBeNull();
  });
});

describe("isRepoNotFoundError", () => {
  it("matches host 'repo missing' phrasings but not auth/network errors", () => {
    expect(isRepoNotFoundError("ERROR: Repository not found.")).toBe(true);
    expect(isRepoNotFoundError("remote: The project you were looking for could not be found")).toBe(true);
    expect(isRepoNotFoundError("fatal: repository 'x' does not exist")).toBe(true);
    expect(isRepoNotFoundError("Permission denied (publickey).")).toBe(false);
    expect(isRepoNotFoundError("Could not resolve hostname github.com")).toBe(false);
  });

  it("does not treat a missing credential helper as a missing repository", () => {
    const detail = `/nonexistent/path/to/helper get: 1: /nonexistent/path/to/helper: not found
fatal: could not read Username for 'https://github.com': terminal prompts disabled`;
    expect(isRepoNotFoundError(detail)).toBe(false);
  });
});

describe("ensureMapRemoteExists", () => {
  const remote = "git@github.com:me/code-map.git";

  beforeEach(() => {
    probeMock.mockReset();
    ghAvailableMock.mockReset();
    ghCreateMock.mockReset().mockResolvedValue(undefined);
    confirmMock.mockReset();
    interactiveMock.mockReset().mockReturnValue(false);
  });

  it("is a no-op when the remote exists", async () => {
    probeMock.mockResolvedValue({ ok: true, detail: "" });
    await ensureMapRemoteExists(remote);
    expect(ghCreateMock).not.toHaveBeenCalled();
  });

  it("leaves auth/network failures for clone to report", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "Permission denied (publickey)." });
    await ensureMapRemoteExists(remote);
    expect(ghCreateMock).not.toHaveBeenCalled();
  });

  it("does not create a repo when the credential helper is missing", async () => {
    probeMock.mockResolvedValue({
      ok: false,
      detail: `/nonexistent/path/to/helper get: 1: /nonexistent/path/to/helper: not found
fatal: could not read Username for 'https://github.com': terminal prompts disabled`,
    });
    await ensureMapRemoteExists(remote, { yes: true });
    expect(ghAvailableMock).not.toHaveBeenCalled();
    expect(ghCreateMock).not.toHaveBeenCalled();
  });

  it("creates the repo with --yes when it is missing and gh is available", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "ERROR: Repository not found." });
    ghAvailableMock.mockResolvedValue(true);
    await ensureMapRemoteExists(remote, { yes: true });
    expect(ghCreateMock).toHaveBeenCalledWith("me/code-map");
  });

  it("creates the repo when the user confirms interactively", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "ERROR: Repository not found." });
    ghAvailableMock.mockResolvedValue(true);
    interactiveMock.mockReturnValue(true);
    confirmMock.mockResolvedValue(true);
    await ensureMapRemoteExists(remote);
    expect(ghCreateMock).toHaveBeenCalledWith("me/code-map");
  });

  it("throws an actionable error when the user declines", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "ERROR: Repository not found." });
    ghAvailableMock.mockResolvedValue(true);
    interactiveMock.mockReturnValue(true);
    confirmMock.mockResolvedValue(false);
    await expect(ensureMapRemoteExists(remote)).rejects.toThrow(/Map remote not found/);
    expect(ghCreateMock).not.toHaveBeenCalled();
  });

  it("throws with the gh command when non-interactive without --yes", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "ERROR: Repository not found." });
    ghAvailableMock.mockResolvedValue(true);
    await expect(ensureMapRemoteExists(remote)).rejects.toThrow(/gh repo create me\/code-map --private/);
  });

  it("throws with manual instructions when gh is unavailable", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "ERROR: Repository not found." });
    ghAvailableMock.mockResolvedValue(false);
    await expect(ensureMapRemoteExists(remote)).rejects.toThrow(/github\.com\/new/);
    expect(ghCreateMock).not.toHaveBeenCalled();
  });

  it("throws host-agnostic instructions for non-GitHub remotes", async () => {
    probeMock.mockResolvedValue({ ok: false, detail: "repository does not exist" });
    await expect(ensureMapRemoteExists("git@gitlab.com:me/map.git")).rejects.toThrow(
      /create an empty private repo on your git host/,
    );
    expect(ghAvailableMock).not.toHaveBeenCalled();
  });
});
