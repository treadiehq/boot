import { beforeEach, describe, expect, it, vi } from "vitest";

const openSourceMock = vi.hoisted(() => vi.fn());
const readPublishedMock = vi.hoisted(() => vi.fn());
const providerPlanMock = vi.hoisted(() => vi.fn());
const providerApplyMock = vi.hoisted(() => vi.fn());
const writeContextMock = vi.hoisted(() => vi.fn());
const cleanupMock = vi.hoisted(() => vi.fn());

vi.mock("../core/workspaceSource", () => ({
  openWorkspaceSource: openSourceMock,
}));
vi.mock("../core/workspaceStore", () => ({
  readPublishedWorkspace: readPublishedMock,
}));
vi.mock("../core/localProvider", () => ({
  getWorkspaceProvider: vi.fn(() => ({
    name: "local",
    plan: providerPlanMock,
    apply: providerApplyMock,
  })),
}));
vi.mock("../core/context", () => ({
  CONTEXT_VERSION: 1,
  writeWorkspaceContext: writeContextMock,
}));

import {
  bootstrapAgentWorkspace,
  bootstrapOutput,
} from "../core/bootstrap";
import { workspaceDefinitionSchema } from "../core/workspace";

const definition = workspaceDefinitionSchema.parse({
  schemaVersion: 1,
  workspace: { id: "acme/billing", name: "Billing" },
  repositories: {
    api: { url: "https://example.test/api.git", path: "services/api" },
    docs: { url: "https://example.test/docs.git", path: "docs" },
  },
  commands: {
    setup: { run: "pnpm install", repository: "api" },
  },
  env: {
    required: [{ name: "API_KEY", source: "boot", secret: true }],
  },
  profiles: {
    local: { repositories: "all", hydrate: "manual" },
    agent: {
      repositories: ["api"],
      commands: ["setup"],
      env: ["API_KEY"],
      hydrate: "eager",
    },
  },
  defaults: { profile: "local" },
});

const finalPlan = {
  workspace: { id: "acme/billing", name: "Billing", profile: "agent" },
  provider: "local",
  root: "/workspace",
  readOnly: false,
  repositories: [
    {
      id: "api",
      path: "services/api",
      state: "hydrated" as const,
      action: "none" as const,
    },
  ],
  tools: [],
  services: [],
  environment: [
    {
      name: "API_KEY",
      secret: true,
      source: "boot",
      available: true,
      availableFrom: "boot" as const,
    },
  ],
  commands: {
    setup: {
      id: "setup",
      run: "pnpm install",
      repository: "api",
    },
  },
  constraints: [],
  ready: true,
  blockers: [],
};

describe("bootstrapAgentWorkspace", () => {
  beforeEach(() => {
    cleanupMock.mockReset().mockResolvedValue(undefined);
    openSourceMock.mockReset().mockResolvedValue({
      kind: "git",
      state: "linked",
      mapDir: "/map",
      inspectionRoot: "/workspace",
      cleanup: cleanupMock,
    });
    readPublishedMock.mockReset().mockResolvedValue(definition);
    providerPlanMock.mockReset().mockResolvedValue({
      ...finalPlan,
      repositories: [
        {
          id: "api",
          path: "services/api",
          state: "missing",
          action: "clone",
        },
      ],
      ready: false,
      blockers: ["repository api: repository needs to be downloaded"],
    });
    providerApplyMock.mockReset().mockResolvedValue({
      plan: finalPlan,
      applied: [{ kind: "repository", name: "api" }],
      failures: [],
      ready: true,
    });
    writeContextMock.mockReset().mockResolvedValue(undefined);
  });

  it("resolves the agent profile before realizing repositories", async () => {
    const result = await bootstrapAgentWorkspace(
      "https://token@example.test/private-map.git",
      "/workspace",
      { runSetup: true },
    );

    const resolvedWorkspace = providerPlanMock.mock.calls[0]![1];
    expect(resolvedWorkspace.profile).toBe("agent");
    expect(resolvedWorkspace.repositories.map((repository: { id: string }) => repository.id))
      .toEqual(["api"]);
    expect(providerApplyMock).toHaveBeenCalledWith(
      "/workspace",
      resolvedWorkspace,
      expect.any(Object),
      { materializeEnv: true, runSetup: true },
    );
    expect(writeContextMock).toHaveBeenCalledOnce();
    expect(cleanupMock).toHaveBeenCalledOnce();

    const output = bootstrapOutput(result);
    expect(output).toMatchObject({
      schemaVersion: 1,
      mode: "workspace",
      source: { kind: "git", state: "linked" },
      ready: true,
      diagnostics: {
        workspace: {
          id: "acme/billing",
          profile: "agent",
          root: "/workspace",
        },
        repositories: [
          {
            id: "api",
            relativePath: "services/api",
            path: "/workspace/services/api",
          },
        ],
      },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("private-map");
    expect(serialized).not.toContain("API_KEY=");
  });

  it("previews without applying or recording active context", async () => {
    openSourceMock.mockResolvedValue({
      kind: "git",
      state: "preview",
      mapDir: "/preview/.boot/map",
      inspectionRoot: "/preview",
      cleanup: cleanupMock,
    });

    const result = await bootstrapAgentWorkspace(
      "git@example.test:map.git",
      "/workspace",
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(providerApplyMock).not.toHaveBeenCalled();
    expect(writeContextMock).not.toHaveBeenCalled();
    expect(cleanupMock).toHaveBeenCalledOnce();
    if (result.mode === "workspace") {
      expect(result.plan.root).toBe("/workspace");
    }
  });
});
