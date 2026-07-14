import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/git")>();
  return {
    ...actual,
    ensureGitAvailable: vi.fn(),
    getLastCommitDate: vi.fn(),
    gitAheadBehind: vi.fn(),
  };
});
vi.mock("../core/placeholder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/placeholder")>();
  return { ...actual, readPlaceholder: vi.fn() };
});
vi.mock("../core/scanner", () => ({ scanWorkspace: vi.fn() }));

import { doctorCommand } from "../commands/doctor";
import { DEFAULT_CONFIG } from "../core/config";
import { ensureGitAvailable, getLastCommitDate, gitAheadBehind } from "../core/git";
import type { RepoEntry } from "../core/manifest";
import { readPlaceholder } from "../core/placeholder";
import { scanWorkspace, type ScanResult } from "../core/scanner";

const ensureGitMock = vi.mocked(ensureGitAvailable);
const lastCommitMock = vi.mocked(getLastCommitDate);
const aheadBehindMock = vi.mocked(gitAheadBehind);
const readPlaceholderMock = vi.mocked(readPlaceholder);
const scanMock = vi.mocked(scanWorkspace);

function repo(
  relativePath: string,
  status: RepoEntry["hydrate"]["status"],
  currentBranch = "main",
): RepoEntry {
  return {
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    absolutePath: `/workspace/${relativePath}`,
    remoteUrl: `git@github.com:example/${relativePath.replaceAll("/", "-")}.git`,
    currentBranch,
    dirty: false,
    lastCommit: null,
    packageManager: null,
    projectType: "unknown",
    detectedFiles: [],
    ignoredHints: [],
    hydrate: { status, strategy: "eager" },
  };
}

function scanResult(): ScanResult {
  return {
    rootName: "workspace",
    sourcePath: "/workspace",
    config: DEFAULT_CONFIG,
    ignoreFiles: [],
    defaultIgnoreRules: [],
    repos: [repo("apps/broken", "hydrated", "feature-branch"), repo("apps/healthy", "local")],
    otherFolders: [],
    hasWorkspaceIgnoreFile: true,
  };
}

describe("doctorCommand", () => {
  beforeEach(() => {
    ensureGitMock.mockReset().mockResolvedValue(undefined);
    lastCommitMock.mockReset().mockResolvedValue(null);
    aheadBehindMock.mockReset().mockResolvedValue({ ahead: 0, behind: 0 });
    readPlaceholderMock.mockReset();
    scanMock.mockReset().mockResolvedValue(scanResult());
  });

  it("reports corrupt hydrated placeholder metadata and continues checking repos", async () => {
    readPlaceholderMock.mockRejectedValue(
      new Error("Placeholder metadata is not valid JSON: /workspace/apps/broken/.boot/repo.json"),
    );
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });

    try {
      await expect(doctorCommand("/workspace")).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }

    const output = lines.join("\n");
    expect(output).toContain(
      "apps/broken/.boot/repo.json is invalid; repository branch checks were skipped. Run `boot pull` from the workspace root to recreate it",
    );
    expect(output).toContain("Repositories checked: 2");
    expect(output).toContain("Warnings: 1");
    expect(readPlaceholderMock).toHaveBeenCalledOnce();
  });
});
