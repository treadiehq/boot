import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoEntry } from "../core/manifest";

vi.mock("../core/git", () => ({
  gitAheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
  gitFastForwardOnly: vi.fn(async () => true),
  gitFetch: vi.fn(async () => false),
  gitUpstreamRef: vi.fn(async () => "origin/main"),
  isDirty: vi.fn(async () => false),
  isGitRepo: vi.fn(() => true),
}));

import { gitAheadBehind, gitFetch, gitUpstreamRef } from "../core/git";
import { runFreshness } from "../core/freshness";

function repo(): RepoEntry {
  return {
    name: "app",
    relativePath: "app",
    absolutePath: "/workspace/app",
    remoteUrl: "git@example.com:app.git",
    currentBranch: "main",
    dirty: false,
    lastCommit: "abc123",
    packageManager: null,
    projectType: "unknown",
    detectedFiles: [],
    ignoredHints: [],
    hydrate: { status: "local", strategy: "eager" },
  };
}

describe("runFreshness fetch failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports fetch-failed without trusting stale upstream refs", async () => {
    const report = await runFreshness([repo()], { fastForward: true });

    expect(report.repos[0]).toMatchObject({ status: "fetch-failed", ahead: 0, behind: 0 });
    expect(report.counts["fetch-failed"]).toBe(1);
    expect(report.counts["up-to-date"]).toBe(0);
    expect(gitFetch).toHaveBeenCalledWith("/workspace/app");
    expect(gitUpstreamRef).not.toHaveBeenCalled();
    expect(gitAheadBehind).not.toHaveBeenCalled();
  });
});
