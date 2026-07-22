import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMock = vi.hoisted(() => vi.fn());
const outputMock = vi.hoisted(() => vi.fn());

vi.mock("../core/git", () => ({ ensureGitAvailable: vi.fn() }));
vi.mock("../core/bootstrap", () => ({
  bootstrapAgentWorkspace: bootstrapMock,
  bootstrapOutput: outputMock,
}));

import { agentCommand } from "../commands/agent";

function compatibilityResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mode: "compatibility",
    root: "/workspace",
    source: { kind: "git", state: "preview" },
    dryRun: true,
    reconciliation: {
      placeholders: 1,
      cloned: 0,
      skipped: 0,
      plan: [{ relativePath: "docs", action: "placeholder" }],
      failures: [],
    },
    hydration: { planned: [], completed: [] },
    environmentFiles: 0,
    failures: [],
    warnings: [],
    ready: false,
    ...overrides,
  };
}

describe("agentCommand", () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    bootstrapMock.mockReset();
    outputMock.mockReset().mockReturnValue({ schemaVersion: 1, ready: false });
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      lines.push(String(message ?? ""));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one JSON document and does not fail a dry run", async () => {
    bootstrapMock.mockResolvedValue(compatibilityResult());

    await expect(
      agentCommand("git@example.com:map.git", "/workspace", {
        dryRun: true,
        json: true,
      }),
    ).resolves.toBeUndefined();

    expect(lines).toEqual([JSON.stringify({ schemaVersion: 1, ready: false }, null, 2)]);
    expect(outputMock).toHaveBeenCalledOnce();
  });

  it("forwards the canonical profile, provider, setup, and env policy", async () => {
    bootstrapMock.mockResolvedValue(
      compatibilityResult({ ready: true, dryRun: false }),
    );

    await agentCommand("git@example.com:map.git", "/workspace", {
      profile: "review",
      provider: "local",
      runSetup: true,
      env: false,
      json: true,
    });

    expect(bootstrapMock).toHaveBeenCalledWith(
      "git@example.com:map.git",
      "/workspace",
      expect.objectContaining({
        profile: "review",
        provider: "local",
        runSetup: true,
        env: false,
      }),
    );
  });

  it("prints structured diagnostics before returning a failing exit", async () => {
    bootstrapMock.mockResolvedValue(
      compatibilityResult({
        dryRun: false,
        failures: [
          {
            kind: "repository",
            name: "api",
            message: "authentication failed",
          },
        ],
      }),
    );

    await expect(
      agentCommand("git@example.com:map.git", "/workspace", { json: true }),
    ).rejects.toThrow(/agent workspace is not ready: 1 problem/i);

    expect(lines).toHaveLength(1);
    expect(outputMock).toHaveBeenCalledOnce();
  });
});
