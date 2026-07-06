import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock only the git side-effects; keep the real `isGitRepo` (existsSync-based)
// so placeholder/real-repo detection works against the temp filesystem.
vi.mock("../core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/git")>();
  return {
    ...actual,
    ensureGitAvailable: vi.fn(async () => {}),
    cloneRepo: vi.fn(),
    checkoutBranch: vi.fn(async () => {}),
  };
});

import { checkoutBranch, cloneRepo } from "../core/git";
import { hydratePlaceholder } from "../core/hydrate";
import { hydrateCommand } from "../commands/hydrate";
import {
  buildPlaceholderMeta,
  isPlaceholder,
  placeholderPaths,
  PLACEHOLDER_DIR,
  readPlaceholder,
  writePlaceholder,
} from "../core/placeholder";

const cloneMock = vi.mocked(cloneRepo);
const checkoutMock = vi.mocked(checkoutBranch);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-hydrate-test-"));
  cloneMock.mockReset();
  checkoutMock.mockReset();
  checkoutMock.mockResolvedValue(undefined);
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

async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("hydrateCommand", () => {
  it("clones into the placeholder, preserves .boot, and marks hydrated", async () => {
    const repoDir = await makePlaceholder("apps/kplane", "git@example.com:kplane.git");

    // Simulate a clone by populating the temp clone target.
    cloneMock.mockImplementation(async (_url: string, target: string) => {
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
      await fs.writeFile(path.join(target, "README.md"), "# kplane\n");
      await fs.writeFile(path.join(target, "package.json"), "{}\n");
    });

    await hydrateCommand(repoDir);

    expect(cloneMock).toHaveBeenCalledTimes(1);
    expect(checkoutMock).toHaveBeenCalledWith(repoDir, "main");

    // Cloned content landed in the placeholder folder.
    await expect(fs.readFile(path.join(repoDir, "package.json"), "utf8")).resolves.toBe("{}\n");
    expect(isPlaceholder(repoDir)).toBe(true);

    const meta = await readPlaceholder(repoDir);
    expect(meta?.hydrateStatus).toBe("hydrated");

    // The preserved placeholder folder is excluded so the repo stays clean.
    const exclude = await fs.readFile(path.join(repoDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(`${PLACEHOLDER_DIR}/`);
  });

  it("reports checkout failure without claiming the repo is ready to work in", async () => {
    const repoDir = await makePlaceholder("apps/feature", "git@example.com:feature.git");
    cloneMock.mockImplementation(async (_url: string, target: string) => {
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
      await fs.writeFile(path.join(target, "README.md"), "# feature\n");
    });
    checkoutMock.mockRejectedValue(new Error("branch not found"));

    const output = await captureLogs(() => hydrateCommand(repoDir));

    expect(output).toContain("could not checkout the recorded branch");
    expect(output).not.toContain("start working");
  });

  it("returns a distinct outcome when clone succeeds but checkout fails", async () => {
    const repoDir = await makePlaceholder("apps/mismatch", "git@example.com:mismatch.git");
    const failedBranches: string[] = [];
    cloneMock.mockImplementation(async (_url: string, target: string) => {
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
      await fs.writeFile(path.join(target, "README.md"), "# mismatch\n");
    });
    checkoutMock.mockRejectedValue(new Error("branch not found"));

    const outcome = await hydratePlaceholder(repoDir, {
      onCheckoutFailed: (branch) => failedBranches.push(branch),
    });

    expect(outcome).toBe("hydrated-checkout-failed");
    expect(failedBranches).toEqual(["main"]);
    expect((await readPlaceholder(repoDir))?.hydrateStatus).toBe("hydrated");
  });

  it("is a no-op when the folder is already a real git repo", async () => {
    const repoDir = await makePlaceholder("apps/existing", "git@example.com:existing.git");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    await hydrateCommand(repoDir);

    expect(cloneMock).not.toHaveBeenCalled();
  });

  it("throws when the folder is not a placeholder", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain, { recursive: true });

    await expect(hydrateCommand(plain)).rejects.toThrow(/not a boot placeholder/);
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it("throws when the placeholder has no remote URL", async () => {
    const repoDir = await makePlaceholder("old/local-tool", null);

    await expect(hydrateCommand(repoDir)).rejects.toThrow(/not hydratable/);
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it("leaves the placeholder intact when cloning fails", async () => {
    const repoDir = await makePlaceholder("apps/flaky", "git@example.com:flaky.git");
    cloneMock.mockRejectedValue(new Error("network down"));

    await expect(hydrateCommand(repoDir)).rejects.toThrow(/Clone failed/);

    // Placeholder metadata is untouched and the folder is not a git repo.
    const meta = await readPlaceholder(repoDir);
    expect(meta?.hydrateStatus).toBe("placeholder");
    expect(await fs.readdir(repoDir)).toEqual([PLACEHOLDER_DIR]);
    expect(placeholderPaths(repoDir).jsonPath).toContain(PLACEHOLDER_DIR);
  });
});
