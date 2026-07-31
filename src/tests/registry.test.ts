import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isRegisteredWorkspace,
  listWorkspaces,
  recordWorkspace,
  registryPath,
  removeWorkspace,
} from "../core/registry";

let home: string;
let previousBootHome: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "boot-registry-"));
  previousBootHome = process.env.BOOT_HOME;
  process.env.BOOT_HOME = home;
});

afterEach(async () => {
  if (previousBootHome === undefined) delete process.env.BOOT_HOME;
  else process.env.BOOT_HOME = previousBootHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("workspace registry", () => {
  it("records, lists, and deduplicates workspaces by root", async () => {
    const workspace = path.join(home, "code");
    await fs.mkdir(workspace, { recursive: true });

    await recordWorkspace(workspace, "Code");
    await recordWorkspace(path.join(home, "other"));
    await recordWorkspace(workspace); // touch again — moves to front, keeps name

    const entries = await listWorkspaces();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ root: workspace, name: "Code", exists: true });
    expect(entries[1]).toMatchObject({ name: null, exists: false });
    await expect(isRegisteredWorkspace(workspace)).resolves.toBe(true);
  });

  it("removes entries and survives a corrupt registry file", async () => {
    const workspace = path.join(home, "code");
    await recordWorkspace(workspace);
    await removeWorkspace(workspace);
    await expect(listWorkspaces()).resolves.toEqual([]);
    await expect(isRegisteredWorkspace(workspace)).resolves.toBe(false);

    await fs.mkdir(path.dirname(registryPath()), { recursive: true });
    await fs.writeFile(registryPath(), "not json", "utf8");
    await expect(listWorkspaces()).resolves.toEqual([]);
    await recordWorkspace(workspace);
    await expect(isRegisteredWorkspace(workspace)).resolves.toBe(true);
  });
});
