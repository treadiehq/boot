import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileFromMap, type ReconcileHooks } from "../core/reconcile";
import type { SharedRepo } from "../core/map";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-plan-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function mk(name: string, relativePath: string, remoteUrl: string | null = null): SharedRepo {
  return {
    name,
    relativePath,
    remoteUrl,
    branch: null,
    lastCommit: null,
    packageManager: null,
    projectType: "unknown",
  } as SharedRepo;
}

const repos: SharedRepo[] = [
  mk("api", "apps/api", "git@example.com:api.git"),
  mk("web", "apps/web", "git@example.com:web.git"),
  mk("local", "tools/local"), // no remote → always a placeholder
];

describe("reconcileFromMap dry run", () => {
  it("plans placeholders without touching the filesystem", async () => {
    const result = await reconcileFromMap(root, repos, { dryRun: true });
    expect(result.placeholders).toBe(3);
    expect(result.cloned).toBe(0);
    expect(result.plan.map((p) => p.relativePath)).toEqual(["apps/api", "apps/web", "tools/local"]);
    expect(result.plan.every((p) => p.action === "placeholder")).toBe(true);
    // Nothing written.
    expect(existsSync(path.join(root, "apps", "api"))).toBe(false);
  });

  it("predicts clones for repos with a remote when eager", async () => {
    const result = await reconcileFromMap(root, repos, { eager: true, dryRun: true });
    expect(result.cloned).toBe(2); // api + web
    expect(result.placeholders).toBe(1); // local (no remote)
    const local = result.plan.find((p) => p.relativePath === "tools/local");
    expect(local?.action).toBe("placeholder");
  });

  it("counts already-present repos as skipped", async () => {
    await fs.mkdir(path.join(root, "apps", "api"), { recursive: true });
    await fs.mkdir(path.join(root, "apps", "api", ".boot"), { recursive: true });
    await fs.writeFile(
      path.join(root, "apps", "api", ".boot", "repo.json"),
      JSON.stringify({ relativePath: "apps/api" }),
    );
    const result = await reconcileFromMap(root, repos, { dryRun: true });
    expect(result.skipped).toBe(1);
    expect(result.plan.map((p) => p.relativePath)).not.toContain("apps/api");
  });
});

describe("reconcileFromMap progress hooks", () => {
  it("fires onItem / onItemDone for each materialised repo", async () => {
    const started: string[] = [];
    const done: Array<{ rel: string; index: number; total: number }> = [];
    const hooks: ReconcileHooks = {
      onItem: ({ relativePath }) => started.push(relativePath),
      onItemDone: ({ relativePath, index, total }) => done.push({ rel: relativePath, index, total }),
    };

    const result = await reconcileFromMap(root, repos, { hooks });
    expect(result.placeholders).toBe(3);
    expect(started).toEqual(["apps/api", "apps/web", "tools/local"]);
    expect(done).toHaveLength(3);
    expect(done[0]).toMatchObject({ index: 1, total: 3 });
    expect(done[2]).toMatchObject({ index: 3, total: 3 });
    // Placeholders really were written this time.
    expect(existsSync(path.join(root, "apps", "api", ".boot", "repo.json"))).toBe(true);
  });
});
