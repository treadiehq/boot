import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const pullMock = vi.hoisted(() => vi.fn());

vi.mock("../core/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/git")>();
  return { ...actual, ensureGitAvailable: vi.fn() };
});
vi.mock("../core/map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/map")>();
  return { ...actual, isLinked: vi.fn(), readWorkspaceMap: vi.fn() };
});
vi.mock("../core/reconcile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/reconcile")>();
  return { ...actual, reconcileFromMap: vi.fn() };
});
vi.mock("../core/lock", () => ({
  withWorkspaceMapLock: vi.fn(async (_root: string, action: () => Promise<unknown>) => action()),
}));
vi.mock("../core/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/transport")>();
  return { ...actual, loadTransport: vi.fn(async () => ({ pull: pullMock })) };
});
vi.mock("../core/workspaceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/workspaceStore")>();
  return { ...actual, readPublishedWorkspace: vi.fn() };
});
vi.mock("../commands/up", () => ({ upCommand: vi.fn() }));

import { agentCommand } from "../commands/agent";
import { upCommand } from "../commands/up";
import { ensureGitAvailable } from "../core/git";
import { emptyWorkspaceMap, isLinked, readWorkspaceMap } from "../core/map";
import { reconcileFromMap } from "../core/reconcile";
import { workspaceDefinitionSchema } from "../core/workspace";
import { readPublishedWorkspace } from "../core/workspaceStore";

const ensureGitMock = vi.mocked(ensureGitAvailable);
const isLinkedMock = vi.mocked(isLinked);
const readMapMock = vi.mocked(readWorkspaceMap);
const reconcileMock = vi.mocked(reconcileFromMap);
const readPublishedMock = vi.mocked(readPublishedWorkspace);
const upMock = vi.mocked(upCommand);

const published = workspaceDefinitionSchema.parse({
  schemaVersion: 1,
  workspace: { id: "test/workspace", name: "test" },
  repositories: {
    api: { path: "api" },
    docs: { path: "docs" },
  },
  profiles: {
    agent: {
      repositories: ["api"],
      hydrate: "eager",
    },
  },
});

describe("agentCommand dry run", () => {
  beforeEach(() => {
    ensureGitMock.mockReset().mockResolvedValue(undefined);
    isLinkedMock.mockReset().mockReturnValue(true);
    readMapMock.mockReset().mockResolvedValue(emptyWorkspaceMap("test"));
    reconcileMock.mockReset().mockResolvedValue({
      placeholders: 1,
      cloned: 0,
      skipped: 0,
      plan: [{ relativePath: "docs", action: "placeholder" }],
      failures: [],
    });
    readPublishedMock.mockReset().mockResolvedValue(published);
    upMock.mockReset().mockResolvedValue(undefined);
    pullMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("previews legacy reconciliation before the published agent profile", async () => {
    const root = path.resolve("/workspace");

    await agentCommand("git@example.com:map.git", root, { dryRun: true });

    expect(reconcileMock).toHaveBeenCalledWith(root, [], {
      eager: undefined,
      dryRun: true,
    });
    expect(upMock).toHaveBeenCalledWith(root, {
      profile: "agent",
      provider: "local",
      env: undefined,
      dryRun: true,
    });
    expect(reconcileMock.mock.invocationCallOrder[0]).toBeLessThan(
      upMock.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps legacy override flags on the legacy dry-run path", async () => {
    await agentCommand("git@example.com:map.git", "/workspace", {
      dryRun: true,
      eager: true,
    });

    expect(reconcileMock).toHaveBeenCalledWith(path.resolve("/workspace"), [], {
      eager: true,
      dryRun: true,
    });
    expect(upMock).not.toHaveBeenCalled();
  });

  it("fails an eager run after pulling when cloning falls back to a placeholder", async () => {
    reconcileMock.mockResolvedValue({
      placeholders: 1,
      cloned: 0,
      skipped: 0,
      plan: [{ relativePath: "api", action: "clone" }],
      failures: [{ relativePath: "api", message: "authentication failed" }],
    });

    await expect(
      agentCommand("git@example.com:map.git", "/workspace", { eager: true }),
    ).rejects.toThrow(/agent workspace is not ready.*could not be cloned/i);

    expect(pullMock).toHaveBeenCalledOnce();
    expect(readPublishedMock).not.toHaveBeenCalled();
    expect(upMock).not.toHaveBeenCalled();
  });
});
