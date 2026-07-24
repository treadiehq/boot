import { beforeEach, describe, expect, it, vi } from "vitest";

const openSourceMock = vi.hoisted(() => vi.fn());
const readPublishedMock = vi.hoisted(() => vi.fn());
const readMapMock = vi.hoisted(() => vi.fn());
const reconcileMock = vi.hoisted(() => vi.fn());
const scanMock = vi.hoisted(() => vi.fn());
const hydrateMock = vi.hoisted(() => vi.fn());
const cleanupMock = vi.hoisted(() => vi.fn());

vi.mock("../core/workspaceSource", () => ({
  openWorkspaceSource: openSourceMock,
}));
vi.mock("../core/workspaceStore", () => ({
  readPublishedWorkspace: readPublishedMock,
}));
vi.mock("../core/map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/map")>();
  return { ...actual, readWorkspaceMap: readMapMock };
});
vi.mock("../core/reconcile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/reconcile")>();
  return { ...actual, reconcileFromMap: reconcileMock };
});
vi.mock("../core/scanner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/scanner")>();
  return { ...actual, scanWorkspace: scanMock };
});
vi.mock("../core/hydrate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/hydrate")>();
  return { ...actual, hydratePlaceholder: hydrateMock };
});

import { bootstrapAgentWorkspace } from "../core/bootstrap";
import { emptyWorkspaceMap, type SharedRepo } from "../core/map";
import type { HydrateOutcome } from "../core/hydrate";

const repository: SharedRepo = {
  name: "api",
  relativePath: "services/api",
  remoteUrl: "git@example.test:api.git",
  branch: "main",
  lastCommit: null,
  packageManager: null,
  projectType: "unknown",
};

const emptyReconciliation = {
  placeholders: 0,
  cloned: 0,
  skipped: 0,
  plan: [],
  failures: [],
};

describe("compatibility bootstrap failure state", () => {
  beforeEach(() => {
    cleanupMock.mockReset().mockResolvedValue(undefined);
    openSourceMock.mockReset().mockResolvedValue({
      kind: "git",
      state: "linked",
      mapDir: "/map",
      inspectionRoot: "/workspace",
      cleanup: cleanupMock,
    });
    readPublishedMock.mockReset().mockResolvedValue(null);
    const map = emptyWorkspaceMap("legacy");
    map.repos.push(repository);
    readMapMock.mockReset().mockResolvedValue(map);
    reconcileMock
      .mockReset()
      .mockResolvedValueOnce({
        placeholders: 1,
        cloned: 0,
        skipped: 0,
        plan: [{ relativePath: repository.relativePath, action: "clone" }],
        failures: [
          {
            relativePath: repository.relativePath,
            message: "transient clone failure",
          },
        ],
      })
      .mockResolvedValueOnce(emptyReconciliation);
    scanMock.mockReset().mockResolvedValue({
      repos: [
        {
          relativePath: repository.relativePath,
          absolutePath: `/workspace/${repository.relativePath}`,
          hydrate: { status: "placeholder" },
        },
      ],
    });
    hydrateMock.mockReset();
  });

  async function bootstrapWith(outcome: HydrateOutcome) {
    hydrateMock.mockResolvedValue(outcome);
    const result = await bootstrapAgentWorkspace(
      "git@example.test:map.git",
      "/workspace",
      { eager: true },
    );
    if (result.mode !== "compatibility") {
      throw new Error("expected compatibility bootstrap result");
    }
    return result;
  }

  it.each(["hydrated", "already-hydrated"] as const)(
    "clears a stale clone failure after %s",
    async (outcome) => {
      const result = await bootstrapWith(outcome);

      expect(result.hydration.completed).toEqual([repository.relativePath]);
      expect(result.failures).toEqual([]);
      expect(result.ready).toBe(true);
      expect(cleanupMock).toHaveBeenCalledOnce();
    },
  );

  it("replaces the stale failure when checkout remains incomplete", async () => {
    const result = await bootstrapWith("hydrated-checkout-failed");

    expect(result.hydration.completed).toEqual([]);
    expect(result.failures).toEqual([
      {
        kind: "repository",
        name: repository.relativePath,
        message: "repository was cloned, but its saved branch could not be checked out",
      },
    ]);
    expect(result.ready).toBe(false);
  });

  it("replaces the stale failure when hydration fails again", async () => {
    hydrateMock.mockRejectedValue(new Error("authentication failed"));

    const result = await bootstrapAgentWorkspace(
      "git@example.test:map.git",
      "/workspace",
      { eager: true },
    );
    if (result.mode !== "compatibility") {
      throw new Error("expected compatibility bootstrap result");
    }

    expect(result.hydration.completed).toEqual([]);
    expect(result.failures).toEqual([
      {
        kind: "repository",
        name: repository.relativePath,
        message: "authentication failed",
      },
    ]);
    expect(result.ready).toBe(false);
  });
});
