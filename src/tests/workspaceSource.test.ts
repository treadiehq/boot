import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mapPaths, writeLinkConfig } from "../core/map";
import { openWorkspaceSource } from "../core/workspaceSource";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-workspace-source-"));
  await fs.mkdir(mapPaths(root).mapDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace source", () => {
  it("uses a matching cached source without pulling during dry-run", async () => {
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
});
