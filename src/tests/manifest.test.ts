import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildManifest,
  readManifest,
  writeManifest,
  type ManifestConfig,
  type RepoEntry,
} from "../core/manifest";
import { DEFAULT_IGNORE_RULES } from "../core/ignore";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-manifest-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sampleRepo: RepoEntry = {
  name: "kplane",
  relativePath: "apps/kplane",
  absolutePath: "/Users/dev/code/apps/kplane",
  remoteUrl: "git@github.com:dantelex2/kplane.git",
  currentBranch: "main",
  dirty: false,
  lastCommit: "abc123",
  packageManager: "pnpm",
  projectType: "node",
  detectedFiles: ["package.json", "pnpm-lock.yaml"],
  ignoredHints: ["node_modules"],
  hydrate: { status: "local", strategy: "eager" },
};

const sampleConfig: ManifestConfig = {
  ignoreFiles: [{ path: ".bootignore", scope: "workspace", rules: ["*.log", ".env"] }],
  defaultIgnoreRules: [...DEFAULT_IGNORE_RULES],
};

describe("manifest", () => {
  it("builds a 0.2 manifest with config and hydrate info", () => {
    const manifest = buildManifest({
      rootName: "code",
      sourcePath: "/Users/dev/code",
      config: sampleConfig,
      repos: [sampleRepo],
    });

    expect(manifest.version).toBe("0.2");
    expect(manifest.workspace).toEqual({ rootName: "code", sourcePath: "/Users/dev/code" });
    expect(manifest.config.ignoreFiles).toHaveLength(1);
    expect(manifest.repos[0]!.hydrate).toEqual({ status: "local", strategy: "eager" });
    expect(() => new Date(manifest.createdAt).toISOString()).not.toThrow();
  });

  it("round-trips through write + read", async () => {
    const manifest = buildManifest({
      rootName: "code",
      sourcePath: "/Users/dev/code",
      config: sampleConfig,
      repos: [sampleRepo],
    });
    const file = path.join(dir, "boot-workspace.json");

    await writeManifest(file, manifest);
    const loaded = await readManifest(file);

    expect(loaded).toEqual(manifest);
  });

  it("throws for a missing manifest file", async () => {
    const file = path.join(dir, "nope.json");
    await expect(readManifest(file)).rejects.toThrow(
      new Error(
        `No snapshot was found at "${file}". From the workspace root, create one with \`boot export . --output ${file}\`.`,
      ),
    );
  });

  it("throws for invalid JSON", async () => {
    const file = path.join(dir, "broken.json");
    await fs.writeFile(file, "{ not json");
    await expect(readManifest(file)).rejects.toThrow(/not valid JSON/);
  });

  it("throws for a manifest that fails schema validation", async () => {
    const file = path.join(dir, "bad.json");
    await fs.writeFile(file, JSON.stringify({ version: "0.2", repos: [] }));
    await expect(readManifest(file)).rejects.toThrow(
      new Error(
        `Snapshot at "${file}" has an invalid format (createdAt: Invalid input: expected string, received undefined; workspace: Invalid input: expected object, received undefined; config: Invalid input: expected object, received undefined). From the workspace root, create a new one with \`boot export . --output ${file}\`.`,
      ),
    );
  });
});
