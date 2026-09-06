import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { stringify } from "yaml";
import { LocalWorkspaceProvider } from "../core/localProvider";
import { resolveWorkspace, workspaceDefinitionSchema } from "../core/workspace";
import { versionSatisfies } from "../core/requirements";
import { buildWorkspaceDiagnostics } from "../core/diagnostics";
import { upCommand } from "../commands/up";
import { registryPath } from "../core/registry";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-preparation-"));
  vi.stubEnv("BOOT_HOME", path.join(root, "home"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
const resolve = (extra: Record<string, unknown>) => resolveWorkspace(workspaceDefinitionSchema.parse({
  schemaVersion: 1, workspace: { id: "regression", name: "Regression" }, repositories: {}, ...extra,
}));

describe("preparation safety regressions", () => {
  it("honors every comparator in a runtime range", () => {
    expect(versionSatisfies("v24.0.0", ">=18 <20")).toBe(false);
    expect(versionSatisfies("v19.9.0", ">=18 <20")).toBe(true);
  });
  it("blocks setup after a repository conflict", async () => {
    await fs.mkdir(path.join(root, "repo"));
    const workspace = resolve({ repositories: { repo: { path: "repo" } }, commands: {
      setup: { repository: "repo", run: `node -e "require('fs').writeFileSync('should-not-exist','x')"` },
    } });
    const provider = new LocalWorkspaceProvider();
    const result = await provider.apply(root, workspace, await provider.plan(root, workspace), { runSetup: true });
    expect(result.ready).toBe(false);
    expect(await fs.readdir(path.join(root, "repo"))).toEqual([]);
  });
  it("rejects repository writes through a symlinked parent", async () => {
    const outside = path.join(root, "outside");
    const inside = path.join(root, "inside");
    await fs.mkdir(outside);
    await fs.mkdir(inside);
    await fs.symlink(outside, path.join(inside, "apps"), "dir");
    const provider = new LocalWorkspaceProvider();
    const workspace = resolve({ repositories: { repo: { path: "apps/repo" } } });
    await expect(provider.plan(inside, workspace)).rejects.toThrow(/symlink|outside/i);
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("does not expose arbitrary successful health-check output", async () => {
    const synthetic = "synthetic-probe-canary-927418";
    vi.stubEnv("BOOT_SYNTHETIC_PROBE", synthetic);
    const workspace = resolve({ env: { required: ["BOOT_SYNTHETIC_PROBE"] }, services: {
      service: { check: "node -e 'console.log(process.env.BOOT_SYNTHETIC_PROBE)'" },
    } });
    const plan = await new LocalWorkspaceProvider().inspect(root, workspace);
    expect(JSON.stringify(buildWorkspaceDiagnostics(plan))).not.toContain(synthetic);
  });
  it("recognizes a detached checkout of a tag or SHA as ready", async () => {
    await execa("git", ["init", root]);
    await execa("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"]);
    await execa("git", ["-C", root, "tag", "v1"]);
    await execa("git", ["-C", root, "checkout", "--detach", "v1"]);
    const sha = (await execa("git", ["-C", root, "rev-parse", "HEAD"])).stdout;
    for (const ref of ["v1", sha]) {
      const plan = await new LocalWorkspaceProvider().inspect(root, resolve({ repositories: { repo: { path: ".", ref } } }));
      expect(plan.ready).toBe(true);
    }
  });
  it("dry-run neither records registry state nor executes manifest probes", async () => {
    await fs.writeFile(path.join(root, "boot.yaml"), stringify({
      schemaVersion: 1, workspace: { id: "preview", name: "Preview" }, repositories: { app: { path: "." } },
      services: { db: { check: `node -e "require('fs').writeFileSync('probe-ran','x')"` } },
    }));
    await execa("git", ["init", root]);
    await execa("git", ["-C", root, "add", "boot.yaml"]);
    await execa("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    const index = await fs.readFile(path.join(root, ".git", "index"));
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(root, "boot.yaml"), later, later);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await upCommand(root, { json: true, dryRun: true });
    await expect(fs.stat(registryPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, "probe-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
  });
});
