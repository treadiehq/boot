import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { buildManifest, writeManifest, type ManifestConfig, type RepoEntry } from "../core/manifest";
import { DEFAULT_IGNORE_RULES } from "../core/ignore";
import { isPlaceholder, readPlaceholder, placeholderPaths } from "../core/placeholder";
import { restoreCommand } from "../commands/restore";

const cloneMock = vi.mocked(cloneRepo);
const checkoutMock = vi.mocked(checkoutBranch);

let dir: string;
let logs: string[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-restore-"));
  logs = [];
  cloneMock.mockReset();
  checkoutMock.mockReset();
  checkoutMock.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg ?? ""));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const config: ManifestConfig = {
  ignoreFiles: [],
  defaultIgnoreRules: [...DEFAULT_IGNORE_RULES],
};

function repo(overrides: Partial<RepoEntry>): RepoEntry {
  return {
    name: "kplane",
    relativePath: "apps/kplane",
    absolutePath: "/src/apps/kplane",
    remoteUrl: "git@github.com:dantelex2/kplane.git",
    currentBranch: "main",
    dirty: false,
    lastCommit: "abc123",
    packageManager: "pnpm",
    projectType: "node",
    detectedFiles: ["package.json"],
    ignoredHints: [],
    hydrate: { status: "local", strategy: "manual" },
    ...overrides,
  };
}

async function manifestFile(repos: RepoEntry[]): Promise<string> {
  const manifest = buildManifest({ rootName: "code", sourcePath: "/src", config, repos });
  const file = path.join(dir, "manifest.json");
  await writeManifest(file, manifest);
  return file;
}

describe("restore --lazy", () => {
  it("creates placeholder folders with repo.json + README", async () => {
    const file = await manifestFile([
      repo({ name: "kplane", relativePath: "apps/kplane" }),
    ]);
    const target = path.join(dir, "restored");

    await restoreCommand(file, target, { lazy: true });

    const repoDir = path.join(target, "apps/kplane");
    expect(isPlaceholder(repoDir)).toBe(true);
    expect(existsSync(placeholderPaths(repoDir).readmePath)).toBe(true);

    const meta = await readPlaceholder(repoDir);
    expect(meta).toMatchObject({
      name: "kplane",
      relativePath: "apps/kplane",
      remoteUrl: "git@github.com:dantelex2/kplane.git",
      branch: "main",
      lastCommit: "abc123",
      hydrateStatus: "placeholder",
    });
    // Crucially, no clone happened.
    expect(existsSync(path.join(repoDir, ".git"))).toBe(false);
  });

  it("marks a repo with no remote URL as not hydratable", async () => {
    const file = await manifestFile([
      repo({ name: "local-tool", relativePath: "old/local-tool", remoteUrl: null }),
    ]);
    const target = path.join(dir, "restored");

    await restoreCommand(file, target, { lazy: true });

    const repoDir = path.join(target, "old/local-tool");
    const meta = await readPlaceholder(repoDir);
    expect(meta?.remoteUrl).toBeNull();
    expect(logs.join("\n")).toMatch(/not hydratable/);
  });

  it("skips a folder that is already a real git repo (already hydrated)", async () => {
    const file = await manifestFile([repo({ relativePath: "apps/kplane" })]);
    const target = path.join(dir, "restored");
    const repoDir = path.join(target, "apps/kplane");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    await restoreCommand(file, target, { lazy: true });

    // No placeholder metadata was written into the real repo.
    expect(isPlaceholder(repoDir)).toBe(false);
    expect(logs.join("\n")).toMatch(/already hydrated/);
  });

  it("preserves an existing placeholder without rewriting it", async () => {
    const file = await manifestFile([repo({ relativePath: "apps/kplane" })]);
    const target = path.join(dir, "restored");

    await restoreCommand(file, target, { lazy: true });
    const repoDir = path.join(target, "apps/kplane");
    const firstCreatedAt = (await readPlaceholder(repoDir))?.createdAt;

    await restoreCommand(file, target, { lazy: true });
    const secondCreatedAt = (await readPlaceholder(repoDir))?.createdAt;

    expect(secondCreatedAt).toBe(firstCreatedAt);
    expect(logs.join("\n")).toMatch(/placeholder already exists/);
  });
});

describe("restore (eager) safety — no cloning required", () => {
  it("creates a folder and warns for a repo with no remote", async () => {
    const file = await manifestFile([
      repo({ name: "local-tool", relativePath: "old/local-tool", remoteUrl: null }),
    ]);
    const target = path.join(dir, "restored");

    await restoreCommand(file, target);

    expect(existsSync(path.join(target, "old/local-tool"))).toBe(true);
    expect(logs.join("\n")).toMatch(/has no remote/);
  });

  it("never overwrites an existing repo", async () => {
    const file = await manifestFile([repo({ relativePath: "apps/kplane" })]);
    const target = path.join(dir, "restored");
    const repoDir = path.join(target, "apps/kplane");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "sentinel.txt"), "keep me");

    await restoreCommand(file, target);

    // The sentinel proves the existing repo was left untouched (not cloned over).
    expect(await fs.readFile(path.join(repoDir, "sentinel.txt"), "utf8")).toBe("keep me");
    expect(logs.join("\n")).toMatch(/already exists/);
  });

  it("does not log repo creation before clone succeeds", async () => {
    const file = await manifestFile([repo({ relativePath: "apps/kplane" })]);
    const target = path.join(dir, "restored");
    cloneMock.mockRejectedValue(new Error("git clone failed: authentication failed"));

    await restoreCommand(file, target);

    expect(existsSync(path.join(target, "apps"))).toBe(true);
    expect(existsSync(path.join(target, "apps/kplane"))).toBe(false);
    expect(logs.join("\n")).not.toContain("created apps/kplane");
  });
});
