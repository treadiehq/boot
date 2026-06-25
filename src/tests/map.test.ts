import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  emptyWorkspaceMap,
  machineStateFromScan,
  mergeReposIntoMap,
  readMachineState,
  readWorkspaceMap,
  sharedRepoFromEntry,
  writeMachineState,
  writeWorkspaceMap,
  type SharedRepo,
} from "../core/map";
import type { ManifestConfig, RepoEntry } from "../core/manifest";
import { DEFAULT_IGNORE_RULES } from "../core/ignore";
import type { MachineIdentity } from "../core/identity";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-map-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const config: ManifestConfig = {
  ignoreFiles: [{ path: ".bootignore", scope: "workspace", rules: ["*.log"] }],
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

const identity: MachineIdentity = {
  machineId: "machine-1",
  hostname: "mac-mini",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("sharedRepoFromEntry", () => {
  it("drops machine-specific fields and renames currentBranch -> branch", () => {
    const shared = sharedRepoFromEntry(repo({}));
    expect(shared).toEqual({
      name: "kplane",
      relativePath: "apps/kplane",
      remoteUrl: "git@github.com:dantelex2/kplane.git",
      branch: "main",
      lastCommit: "abc123",
      packageManager: "pnpm",
      projectType: "node",
    });
    expect(shared).not.toHaveProperty("absolutePath");
    expect(shared).not.toHaveProperty("dirty");
    expect(shared).not.toHaveProperty("hydrate");
  });
});

describe("mergeReposIntoMap", () => {
  it("adds new repos and sorts by relativePath", () => {
    const map = emptyWorkspaceMap("code");
    const scanned: SharedRepo[] = [
      sharedRepoFromEntry(repo({ relativePath: "zeta" })),
      sharedRepoFromEntry(repo({ relativePath: "alpha" })),
    ];
    const merged = mergeReposIntoMap(map, scanned, config);
    expect(merged.repos.map((r) => r.relativePath)).toEqual(["alpha", "zeta"]);
  });

  it("never deletes repos that exist only on another machine", () => {
    let map = emptyWorkspaceMap("code");
    map = mergeReposIntoMap(map, [sharedRepoFromEntry(repo({ relativePath: "a" }))], config);
    // A second machine scans and only sees repo "b".
    map = mergeReposIntoMap(map, [sharedRepoFromEntry(repo({ relativePath: "b" }))], config);
    expect(map.repos.map((r) => r.relativePath).sort()).toEqual(["a", "b"]);
  });

  it("does not let a placeholder-only scan clobber a known remote/branch with null", () => {
    let map = emptyWorkspaceMap("code");
    map = mergeReposIntoMap(
      map,
      [sharedRepoFromEntry(repo({ relativePath: "a", remoteUrl: "git@x:a.git", currentBranch: "main" }))],
      config,
    );
    // Re-merge the same repo as a bare placeholder with no remote info.
    map = mergeReposIntoMap(
      map,
      [{ name: "a", relativePath: "a", remoteUrl: null, branch: null, lastCommit: null, packageManager: null, projectType: "unknown" }],
      config,
    );
    const entry = map.repos.find((r) => r.relativePath === "a")!;
    expect(entry.remoteUrl).toBe("git@x:a.git");
    expect(entry.branch).toBe("main");
  });

  it("keeps existing ignore config when a scan provides none", () => {
    let map = emptyWorkspaceMap("code");
    map = mergeReposIntoMap(map, [], config);
    expect(map.config.ignoreFiles).toHaveLength(1);
    // A later scan with empty ignore config must not erase the rules.
    map = mergeReposIntoMap(map, [], { ignoreFiles: [], defaultIgnoreRules: [] });
    expect(map.config.ignoreFiles).toHaveLength(1);
    expect(map.config.defaultIgnoreRules.length).toBeGreaterThan(0);
  });
});

describe("workspace map + machine state round-trip", () => {
  it("writes and reads back a workspace map", async () => {
    const map = mergeReposIntoMap(emptyWorkspaceMap("code"), [sharedRepoFromEntry(repo({}))], config);
    await writeWorkspaceMap(dir, map);
    const loaded = await readWorkspaceMap(dir);
    expect(loaded).toEqual(map);
  });

  it("returns null for a missing workspace map", async () => {
    expect(await readWorkspaceMap(dir)).toBeNull();
  });

  it("writes machine state under machines/<id>.json and reads it back", async () => {
    const state = machineStateFromScan(identity, "/Users/dev/code", [
      repo({ relativePath: "apps/kplane", hydrate: { status: "placeholder", strategy: "manual" } }),
    ]);
    await writeMachineState(dir, state);

    const onDisk = await fs.stat(path.join(dir, "machines", "machine-1.json"));
    expect(onDisk.isFile()).toBe(true);

    const loaded = await readMachineState(dir, "machine-1");
    expect(loaded?.hostname).toBe("mac-mini");
    expect(loaded?.repos["apps/kplane"]).toEqual({
      hydrateStatus: "placeholder",
      lastCommit: "abc123",
      dirty: false,
    });
  });
});
