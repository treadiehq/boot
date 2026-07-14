import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { inspectCommand } from "../commands/inspect";
import { upCommand } from "../commands/up";
import { CONFIG_FILE_NAME } from "../core/config";
import { readWorkspaceContext } from "../core/context";

let root: string;
let previousSecret: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-workspace-command-"));
  previousSecret = process.env.BILLING_API_KEY;
  process.env.BILLING_API_KEY = "super-secret-value";
  await fs.writeFile(
    path.join(root, CONFIG_FILE_NAME),
    stringifyYaml({
      schemaVersion: 1,
      workspace: { id: "billing", name: "Billing" },
      repositories: {},
      commands: { test: "pnpm test" },
      env: { required: ["BILLING_API_KEY"] },
      constraints: ["Never modify production billing records"],
      profiles: {
        agent: { repositories: "all", env: "all" },
      },
      defaults: { profile: "agent" },
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousSecret === undefined) delete process.env.BILLING_API_KEY;
  else process.env.BILLING_API_KEY = previousSecret;
  await fs.rm(root, { recursive: true, force: true });
});

async function captureJson(run: () => Promise<void>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ""));
  });
  await run();
  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("Workspace commands", () => {
  it("prints structured agent context without secret values", async () => {
    const output = await captureJson(() => inspectCommand(root, { json: true }));
    expect(output.workspace).toMatchObject({
      id: "billing",
      profile: "agent",
      provider: "local",
      ready: true,
    });
    expect(output.constraints).toEqual(["Never modify production billing records"]);
    const serialized = JSON.stringify(output);
    expect(serialized).toContain("BILLING_API_KEY");
    expect(serialized).not.toContain("super-secret-value");
  });

  it("records the active Profile after successful realization", async () => {
    const output = await captureJson(() => upCommand(root, { json: true }));
    expect(output.ready).toBe(true);
    expect(await readWorkspaceContext(root)).toMatchObject({
      workspaceId: "billing",
      profile: "agent",
      provider: "local",
    });
  });

  it("supports a side-effect-free JSON dry run", async () => {
    const output = await captureJson(() => upCommand(root, { json: true, dryRun: true }));
    expect(output.workspace).toMatchObject({ id: "billing", profile: "agent" });
    expect(await readWorkspaceContext(root)).toBeNull();
  });
});
