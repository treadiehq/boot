import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalWorkspaceProvider } from "../core/localProvider";
import { readPlaceholder } from "../core/placeholder";
import { resolveWorkspace, workspaceDefinitionSchema } from "../core/workspace";

let root: string;
let previousBootHome: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-provider-"));
  previousBootHome = process.env.BOOT_HOME;
  process.env.BOOT_HOME = path.join(root, "boot-home");
});

afterEach(async () => {
  if (previousBootHome === undefined) delete process.env.BOOT_HOME;
  else process.env.BOOT_HOME = previousBootHome;
  await fs.rm(root, { recursive: true, force: true });
});

function workspace() {
  return resolveWorkspace(
    workspaceDefinitionSchema.parse({
      schemaVersion: 1,
      workspace: { id: "billing", name: "Billing" },
      repositories: {
        web: {
          url: "https://example.test/web.git",
          path: "apps/web",
          role: "billing UI",
        },
      },
      profiles: {
        agent: { repositories: ["web"], hydrate: "manual" },
      },
    }),
    "agent",
  );
}

describe("LocalWorkspaceProvider", () => {
  it("plans and realizes a lazy repository idempotently", async () => {
    const provider = new LocalWorkspaceProvider();
    const initial = await provider.plan(root, workspace());
    expect(initial.repositories[0]).toMatchObject({
      id: "web",
      action: "placeholder",
      state: "missing",
    });
    expect(initial.ready).toBe(false);

    const result = await provider.apply(root, workspace(), initial);
    expect(result.ready).toBe(true);
    expect(await readPlaceholder(path.join(root, "apps", "web"))).toMatchObject({
      relativePath: "apps/web",
      remoteUrl: "https://example.test/web.git",
    });

    const second = await provider.plan(root, workspace());
    expect(second.repositories[0]?.action).toBe("none");
    expect(second.ready).toBe(true);
  });

  it("refuses to overwrite a plain directory", async () => {
    await fs.mkdir(path.join(root, "apps", "web"), { recursive: true });
    await fs.writeFile(path.join(root, "apps", "web", "notes.txt"), "keep me");

    const provider = new LocalWorkspaceProvider();
    const plan = await provider.plan(root, workspace());
    expect(plan.repositories[0]?.action).toBe("conflict");

    const result = await provider.apply(root, workspace(), plan);
    expect(result.ready).toBe(false);
    expect(result.failures[0]?.message).toMatch(/path exists/);
    await expect(fs.readFile(path.join(root, "apps", "web", "notes.txt"), "utf8")).resolves.toBe(
      "keep me",
    );
  });

  it("treats a selected Boot secret without a local key as a readiness blocker", async () => {
    const resolved = resolveWorkspace(
      workspaceDefinitionSchema.parse({
        schemaVersion: 1,
        workspace: { id: "billing", name: "Billing" },
        repositories: {},
        env: {
          required: [{ name: "BILLING_API_KEY", source: "boot", secret: true }],
        },
        profiles: { agent: { env: ["BILLING_API_KEY"] } },
      }),
      "agent",
    );

    const plan = await new LocalWorkspaceProvider().plan(root, resolved);

    expect(plan.ready).toBe(false);
    expect(plan.environment).toEqual([
      expect.objectContaining({
        name: "BILLING_API_KEY",
        available: false,
      }),
    ]);
    expect(plan.blockers).toContain(
      '"BILLING_API_KEY": required environment variable is not available',
    );
  });

  it("keeps unsupported selected tools as readiness blockers", async () => {
    const resolved = resolveWorkspace(
      workspaceDefinitionSchema.parse({
        schemaVersion: 1,
        workspace: { id: "billing", name: "Billing" },
        repositories: {},
        tools: { "acme-runtime": "3" },
        profiles: { agent: { tools: ["acme-runtime"] } },
      }),
      "agent",
    );

    const plan = await new LocalWorkspaceProvider().plan(root, resolved);

    expect(plan.ready).toBe(false);
    expect(plan.tools).toEqual([
      expect.objectContaining({
        name: "acme-runtime",
        state: "unsupported",
      }),
    ]);
    expect(plan.blockers[0]).toMatch(/acme-runtime.*automatic checks are not available/);
  });

  it("runs selected setup commands only when explicitly requested", async () => {
    const resolved = resolveWorkspace(
      workspaceDefinitionSchema.parse({
        schemaVersion: 1,
        workspace: { id: "billing", name: "Billing" },
        repositories: {},
        commands: {
          setup: `node -e "require('fs').writeFileSync('setup-ran.txt', 'yes')"`,
        },
        profiles: { agent: { commands: ["setup"] } },
      }),
      "agent",
    );
    const provider = new LocalWorkspaceProvider();
    const plan = await provider.plan(root, resolved);

    const withoutSetup = await provider.apply(root, resolved, plan);
    await expect(fs.stat(path.join(root, "setup-ran.txt"))).rejects.toBeTruthy();
    expect(withoutSetup.applied).not.toContainEqual({
      kind: "command",
      name: "setup",
    });

    const withSetup = await provider.apply(root, resolved, plan, { runSetup: true });
    await expect(fs.readFile(path.join(root, "setup-ran.txt"), "utf8")).resolves.toBe("yes");
    expect(withSetup.applied).toContainEqual({ kind: "command", name: "setup" });
    expect(withSetup.ready).toBe(true);
  });

  it("returns a non-ready result when a setup command fails", async () => {
    const resolved = resolveWorkspace(
      workspaceDefinitionSchema.parse({
        schemaVersion: 1,
        workspace: { id: "billing", name: "Billing" },
        repositories: {},
        commands: { setup: `node -e "process.exit(3)"` },
      }),
    );
    const provider = new LocalWorkspaceProvider();
    const plan = await provider.plan(root, resolved);

    const result = await provider.apply(root, resolved, plan, { runSetup: true });

    expect(result.ready).toBe(false);
    expect(result.failures).toContainEqual({
      kind: "command",
      name: "setup",
      message: "exited with status 3",
    });
  });
});
