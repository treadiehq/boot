import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealizationPlan } from "../core/provider";
import type { EnvironmentStatus } from "../core/requirements";
import { renderWorkspacePlan } from "../ui/workspace";

const basePlan = (environment: EnvironmentStatus[]): RealizationPlan => ({
  workspace: { id: "fixture", name: "Fixture", profile: "agent" },
  provider: "local",
  root: "/tmp/fixture",
  readOnly: false,
  repositories: [],
  tools: [],
  services: [],
  environment,
  commands: {},
  constraints: [],
  ready: true,
  blockers: [],
});

async function captureLines(run: () => void): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("renderWorkspacePlan environment source labels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a distinct, specific label for every availableFrom value", async () => {
    const statuses: EnvironmentStatus[] = [
      { name: "PROCESS_VAR", secret: false, source: "process", available: true, availableFrom: "process" },
      { name: "BOOT_VAR", secret: false, source: "boot", available: true, availableFrom: "boot" },
      { name: "SESSION_VAR", secret: false, source: "session", available: true, availableFrom: "session" },
      { name: "OTHER_VAR", secret: false, available: true },
    ];
    const lines = await captureLines(() => renderWorkspacePlan(basePlan(statuses)));
    const find = (name: string) => lines.find((line) => line.includes(`variable ${name}`));
    expect(find("PROCESS_VAR")).toContain("available from the current environment");
    expect(find("BOOT_VAR")).toContain("available from Boot's encrypted storage");
    expect(find("SESSION_VAR")).toContain("available from the session runtime");
    expect(find("OTHER_VAR")).toContain("available from a configured source");
    // Each known source gets its own label, distinct from the generic fallback.
    const labels = lines.filter((line) => line.includes("available from")).map((line) => line.trim());
    expect(new Set(labels).size).toBe(labels.length);
  });
});
