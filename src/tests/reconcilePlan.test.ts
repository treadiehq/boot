import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/git")>();
  return { ...actual, checkoutBranch: vi.fn(), cloneRepo: vi.fn() };
});

import { checkoutBranch, cloneRepo } from "../core/git";
import { reconcileFromMap, type ReconcileHooks } from "../core/reconcile";
import type { SharedRepo } from "../core/map";
import { reconcileProgressHooks, renderReconcileFailures } from "../ui/plan";

const checkoutMock = vi.mocked(checkoutBranch);
const cloneMock = vi.mocked(cloneRepo);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-plan-"));
  checkoutMock.mockReset();
  checkoutMock.mockResolvedValue(undefined);
  cloneMock.mockReset();
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

describe("reconcileFromMap eager cloning", () => {
  it("promotes a successful temporary clone into the final path", async () => {
    const repo = mk("api", "apps/api", "git@example.com:api.git");
    const repoPath = path.join(root, repo.relativePath);
    let clonePath: string | null = null;
    cloneMock.mockImplementation(async (_remote, target) => {
      clonePath = target;
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
    });

    const result = await reconcileFromMap(root, [repo], { eager: true });

    expect(clonePath).not.toBe(repoPath);
    expect(existsSync(clonePath!)).toBe(false);
    expect(existsSync(path.join(repoPath, ".git"))).toBe(true);
    expect(result.cloned).toBe(1);
    expect(result.placeholders).toBe(0);
  });

  it("cleans a partial clone before writing the placeholder fallback", async () => {
    const repo = mk("api", "apps/api", "git@example.com:api.git");
    const repoPath = path.join(root, repo.relativePath);
    let clonePath: string | null = null;
    const onItemDone = vi.fn();
    cloneMock.mockImplementation(async (_remote, target) => {
      clonePath = target;
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
      await fs.writeFile(path.join(target, "partial-object"), "incomplete");
      throw new Error("network dropped");
    });

    const result = await reconcileFromMap(root, [repo], {
      eager: true,
      hooks: { onItemDone },
    });

    expect(existsSync(clonePath!)).toBe(false);
    expect(existsSync(path.join(repoPath, ".git"))).toBe(false);
    expect(existsSync(path.join(repoPath, ".boot", "repo.json"))).toBe(true);
    expect(existsSync(path.join(repoPath, ".boot", "README.md"))).toBe(true);
    expect(await fs.readdir(repoPath)).toEqual([".boot"]);
    expect(result.failures).toEqual([
      { relativePath: "apps/api", message: "network dropped" },
    ]);
    expect(result.placeholders).toBe(1);
    expect(onItemDone).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "apps/api",
        requestedAction: "clone",
        action: "placeholder",
      }),
    );
  });

  it("falls back to a placeholder when the saved branch cannot be checked out", async () => {
    const repo = { ...mk("api", "apps/api", "git@example.com:api.git"), branch: "missing" };
    const repoPath = path.join(root, repo.relativePath);
    let clonePath: string | null = null;
    const onItemDone = vi.fn();
    cloneMock.mockImplementation(async (_remote, target) => {
      clonePath = target;
      await fs.mkdir(path.join(target, ".git"), { recursive: true });
    });
    checkoutMock.mockRejectedValue(new Error("branch does not exist"));

    const result = await reconcileFromMap(root, [repo], {
      eager: true,
      hooks: { onItemDone },
    });

    expect(checkoutMock).toHaveBeenCalledWith(clonePath, "missing");
    expect(existsSync(clonePath!)).toBe(false);
    expect(existsSync(path.join(repoPath, ".git"))).toBe(false);
    expect(existsSync(path.join(repoPath, ".boot", "repo.json"))).toBe(true);
    expect(result.cloned).toBe(0);
    expect(result.placeholders).toBe(1);
    expect(result.failures).toEqual([
      { relativePath: "apps/api", message: "branch does not exist" },
    ]);
    expect(onItemDone).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "apps/api",
        requestedAction: "clone",
        action: "placeholder",
      }),
    );
  });
});

describe("reconcile failure output", () => {
  it("distinguishes a failed eager clone from an intentional placeholder", () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    try {
      reconcileProgressHooks().onItemDone?.({
        index: 1,
        total: 1,
        ms: 10,
        relativePath: "apps/api",
        requestedAction: "clone",
        action: "placeholder",
      });
      renderReconcileFailures([
        { relativePath: "apps/api", message: "authentication failed" },
      ]);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain("clone failed; prepared placeholder for apps/api");
    expect(logs.join("\n")).toContain("apps/api: authentication failed");
    expect(logs.join("\n")).toContain("then hydrate the placeholders");
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
