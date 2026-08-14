import { describe, expect, it } from "vitest";
import {
  bootstrapOutput,
  bootstrapOutputSchema,
  type CompatibilityBootstrapResult,
  type WorkspaceBootstrapResult,
} from "../core/bootstrap";
import {
  buildWorkspaceDiagnostics,
  workspaceDiagnosticsSchema,
} from "../core/diagnostics";
import type { RealizationPlan } from "../core/provider";

const MAP_COMMIT = "a".repeat(40);

const plan: RealizationPlan = {
  workspace: { id: "acme/api", name: "API", profile: "agent" },
  provider: "local",
  root: "/workspace",
  readOnly: false,
  repositories: [
    {
      id: "api",
      path: "services/api",
      role: "backend",
      ref: "main",
      state: "hydrated",
      action: "none",
      currentRef: "main",
      dirty: false,
      detail: "ready",
    },
  ],
  tools: [
    {
      name: "node",
      required: ">=22",
      state: "available",
      observed: "v22.0.0",
      detail: "runtime",
    },
  ],
  services: [{ name: "postgres", state: "available" }],
  commands: {
    setup: {
      id: "setup",
      run: "pnpm install",
      repository: "api",
      description: "Install dependencies",
    },
  },
  environment: [
    {
      name: "API_KEY",
      secret: true,
      source: "boot",
      available: true,
      availableFrom: "boot",
    },
  ],
  constraints: ["Do not access production"],
  ready: true,
  blockers: [],
};

const source = {
  kind: "git" as const,
  state: "updated" as const,
  commit: MAP_COMMIT,
  pinned: true,
};

describe("inspect and bootstrap JSON contracts", () => {
  it("preserves every inspect field and rejects unknown fields recursively", () => {
    const diagnostics = buildWorkspaceDiagnostics(plan);

    expect(workspaceDiagnosticsSchema.parse(diagnostics)).toEqual(diagnostics);
    expect(Object.keys(diagnostics)).toEqual([
      "schemaVersion",
      "workspace",
      "repositories",
      "tools",
      "services",
      "commands",
      "environment",
      "constraints",
      "blockers",
    ]);
    expect(
      workspaceDiagnosticsSchema.safeParse({
        ...diagnostics,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      workspaceDiagnosticsSchema.safeParse({
        ...diagnostics,
        workspace: { ...diagnostics.workspace, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("validates workspace bootstrap output and reports pinning metadata", () => {
    const result: WorkspaceBootstrapResult = {
      schemaVersion: 1,
      mode: "workspace",
      root: "/workspace",
      source,
      dryRun: false,
      ephemeral: true,
      plan,
      applied: [{ kind: "repository", name: "api" }],
      failures: [],
      warnings: [],
      ready: true,
    };

    const output = bootstrapOutput(result);
    expect(output).toMatchObject({
      schemaVersion: 1,
      mode: "workspace",
      source: { commit: MAP_COMMIT, pinned: true },
      dryRun: false,
      ephemeral: true,
      ready: true,
    });
    expect(bootstrapOutputSchema.parse(output)).toEqual(output);
    expect(
      bootstrapOutputSchema.safeParse({
        ...output,
        source: { ...output.source, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("validates compatibility output and rejects unexpected serialized fields", () => {
    const result: CompatibilityBootstrapResult = {
      schemaVersion: 1,
      mode: "compatibility",
      root: "/workspace",
      source,
      dryRun: true,
      ephemeral: false,
      reconciliation: {
        placeholders: 1,
        cloned: 0,
        skipped: 0,
        plan: [{ relativePath: "services/api", action: "placeholder" }],
        failures: [],
      },
      hydration: { planned: [], completed: [] },
      environmentFiles: 0,
      failures: [],
      warnings: [],
      ready: false,
    };

    const output = bootstrapOutput(result);
    if (output.mode !== "compatibility") {
      throw new Error("expected compatibility bootstrap output");
    }
    expect(bootstrapOutputSchema.parse(output)).toEqual(output);
    expect(
      bootstrapOutputSchema.safeParse({
        ...output,
        reconciliation: {
          ...output.reconciliation,
          plan: [
            {
              ...output.reconciliation.plan[0],
              unexpected: true,
            },
          ],
        },
      }).success,
    ).toBe(false);

    const invalid = {
      ...result,
      failures: [
        {
          kind: "repository",
          name: "api",
          message: "failed",
          unexpected: true,
        },
      ],
    } as unknown as CompatibilityBootstrapResult;
    expect(() => bootstrapOutput(invalid)).toThrow();
  });
});
