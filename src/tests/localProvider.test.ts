import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalWorkspaceProvider } from "../core/localProvider";
import { readPlaceholder } from "../core/placeholder";
import { resolveWorkspace, workspaceDefinitionSchema } from "../core/workspace";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-provider-"));
});

afterEach(async () => {
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
});
