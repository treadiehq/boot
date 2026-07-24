import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkCommand } from "../commands/link";
import {
  emptyWorkspaceMap,
  mapPaths,
  readLinkConfig,
  readWorkspaceMap,
  writeLinkConfig,
  writeWorkspaceMap,
} from "../core/map";
import {
  initializeWorkspaceSource,
  openWorkspaceSource,
} from "../core/workspaceSource";

let root: string;
let previousBootHome: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-workspace-source-"));
  previousBootHome = process.env.BOOT_HOME;
  process.env.BOOT_HOME = path.join(root, "home");
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousBootHome === undefined) delete process.env.BOOT_HOME;
  else process.env.BOOT_HOME = previousBootHome;
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace source", () => {
  it("uses a matching cached source without pulling during dry-run", async () => {
    await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
    await writeLinkConfig(root, {
      kind: "git",
      remote: "git@example.test:acme/map.git",
      linkedAt: new Date().toISOString(),
    });

    const source = await openWorkspaceSource(
      "git@example.test:acme/map",
      root,
      { dryRun: true },
    );

    expect(source).toMatchObject({
      kind: "git",
      state: "cached",
      mapDir: mapPaths(root).mapDir,
      inspectionRoot: root,
    });
    await source.cleanup();
  });

  it("rejects a different source without exposing credentials", async () => {
    await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
    await writeLinkConfig(root, {
      kind: "git",
      remote: "https://secret-token@example.test/acme/private-map.git",
      linkedAt: new Date().toISOString(),
    });

    let message = "";
    try {
      await openWorkspaceSource("https://example.test/acme/other-map.git", root, {
        dryRun: true,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("already linked");
    expect(message).not.toContain("secret-token");
  });

  it("never deletes a workspace map that already exists", async () => {
    const paths = mapPaths(root);
    const sentinel = path.join(paths.mapDir, "keep.txt");
    await fs.mkdir(paths.mapDir, { recursive: true });
    await fs.writeFile(sentinel, "keep");
    await writeLinkConfig(root, {
      kind: "folder",
      remote: path.join(root, "shared"),
      linkedAt: new Date().toISOString(),
    });

    await expect(
      initializeWorkspaceSource(path.join(root, "other-shared"), root, {
        folder: true,
      }),
    ).rejects.toThrow(/already linked/i);

    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep");
    expect(await readLinkConfig(root)).toMatchObject({
      kind: "folder",
      remote: path.join(root, "shared"),
    });
  });

  it("serializes concurrent opens without deleting the winning map", async () => {
    const shared = path.join(root, "shared-open");
    const workspace = path.join(root, "open-workspace");
    await writeWorkspaceMap(shared, emptyWorkspaceMap("race"));

    const results = await Promise.allSettled([
      openWorkspaceSource(shared, workspace, { folder: true }),
      openWorkspaceSource(shared, workspace, { folder: true }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await readWorkspaceMap(mapPaths(workspace).mapDir)).toMatchObject({
      workspace: { name: "race" },
    });
    expect(await readLinkConfig(workspace)).toMatchObject({
      kind: "folder",
      remote: shared,
    });
  });

  it("allows only one concurrent link and preserves its completed map", async () => {
    const shared = path.join(root, "shared-link");
    const workspace = path.join(root, "link-workspace");
    await writeWorkspaceMap(shared, emptyWorkspaceMap("race"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    const results = await Promise.allSettled([
      linkCommand(shared, workspace, { folder: true }),
      linkCommand(shared, workspace, { folder: true }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await readWorkspaceMap(mapPaths(workspace).mapDir)).toMatchObject({
      workspace: { name: "race" },
    });
    expect(await readLinkConfig(workspace)).toMatchObject({
      kind: "folder",
      remote: shared,
    });
  });
});
