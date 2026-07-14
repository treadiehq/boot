import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPlaceholderMeta,
  isPlaceholder,
  placeholderPaths,
  readPlaceholder,
  writePlaceholder,
  writePlaceholderReadme,
  type PlaceholderMeta,
} from "../core/placeholder";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-placeholder-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const source = {
  name: "kplane",
  relativePath: "apps/kplane",
  remoteUrl: "git@github.com:dantelex2/kplane.git",
  currentBranch: "main",
  lastCommit: "abc123",
};

describe("buildPlaceholderMeta", () => {
  it("maps a repo source into placeholder metadata", () => {
    const meta = buildPlaceholderMeta(source, "placeholder", new Date("2026-01-01T00:00:00.000Z"));
    expect(meta).toEqual({
      name: "kplane",
      relativePath: "apps/kplane",
      remoteUrl: "git@github.com:dantelex2/kplane.git",
      branch: "main",
      lastCommit: "abc123",
      hydrateStatus: "placeholder",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("placeholder write/read", () => {
  it("writes and reads back metadata", async () => {
    const repoDir = path.join(dir, "apps", "kplane");
    await fs.mkdir(repoDir, { recursive: true });
    const meta = buildPlaceholderMeta(source);

    expect(isPlaceholder(repoDir)).toBe(false);
    await writePlaceholder(repoDir, meta);
    expect(isPlaceholder(repoDir)).toBe(true);

    const loaded = await readPlaceholder(repoDir);
    expect(loaded).toEqual(meta);
  });

  it("writes a README that mentions the hydrate command for hydratable repos", async () => {
    const repoDir = path.join(dir, "kplane");
    await fs.mkdir(repoDir, { recursive: true });
    const meta = buildPlaceholderMeta(source);
    await writePlaceholderReadme(repoDir, meta);

    const readme = await fs.readFile(placeholderPaths(repoDir).readmePath, "utf8");
    expect(readme).toContain("boot hydrate apps/kplane");
  });

  it("explains that a placeholder without a repository URL cannot be downloaded", async () => {
    const repoDir = path.join(dir, "local-tool");
    await fs.mkdir(repoDir, { recursive: true });
    const meta = buildPlaceholderMeta({ ...source, remoteUrl: null });
    await writePlaceholderReadme(repoDir, meta);

    const readme = await fs.readFile(placeholderPaths(repoDir).readmePath, "utf8");
    expect(readme).toContain("No repository URL is recorded, so Boot cannot download it.");
    expect(readme).toContain(
      "Add its URL to `boot.yaml`, then run `boot up .` from the workspace root.",
    );
  });

  it("returns null when the folder is not a placeholder", async () => {
    const repoDir = path.join(dir, "plain");
    await fs.mkdir(repoDir, { recursive: true });
    expect(await readPlaceholder(repoDir)).toBeNull();
  });

  it("throws for invalid placeholder JSON", async () => {
    const repoDir = path.join(dir, "broken");
    const { dir: metaDir, jsonPath } = placeholderPaths(repoDir);
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(jsonPath, "{ not json");
    await expect(readPlaceholder(repoDir)).rejects.toThrow(/not valid JSON/);
  });

  it("throws for placeholder JSON that fails validation", async () => {
    const repoDir = path.join(dir, "bad");
    const { dir: metaDir, jsonPath } = placeholderPaths(repoDir);
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify({ name: "x" } satisfies Partial<PlaceholderMeta>));
    await expect(readPlaceholder(repoDir)).rejects.toThrow(
      new Error(
        `Repository download information at "${jsonPath}" has an invalid format (relativePath: Invalid input: expected string, received undefined; remoteUrl: Invalid input: expected string, received undefined; branch: Invalid input: expected string, received undefined). Run \`boot pull\` from the workspace root to recreate it.`,
      ),
    );
  });
});
