import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initCommand } from "../commands/init";
import { IGNORE_FILE_NAME } from "../core/ignore";
import { CONFIG_FILE_NAME } from "../core/config";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-init-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const IGNORE = IGNORE_FILE_NAME;
const CONFIG = CONFIG_FILE_NAME;

describe("initCommand", () => {
  it("creates default ignore and config files", async () => {
    await initCommand(root);

    const ignore = await fs.readFile(path.join(root, IGNORE), "utf8");
    const config = await fs.readFile(path.join(root, CONFIG), "utf8");

    // Default ignore content (matches the documented defaults).
    for (const rule of [
      "node_modules/",
      ".next/",
      "dist/",
      "build/",
      "target/",
      ".venv/",
      ".cache/",
      ".turbo/",
      ".DS_Store",
      "*.log",
      ".env",
      ".env.local",
    ]) {
      expect(ignore).toContain(rule);
    }

    expect(config).toContain("strategy: manual");
    expect(config).toContain("staleAfterDays: 30");
    expect(config).toContain("- main");
    expect(config).toContain("- master");
  });

  it("does not overwrite existing files without --force", async () => {
    await fs.writeFile(path.join(root, IGNORE), "custom-rule\n");
    await fs.writeFile(path.join(root, CONFIG), "workspace:\n  name: mine\n");

    await initCommand(root);

    expect(await fs.readFile(path.join(root, IGNORE), "utf8")).toBe("custom-rule\n");
    expect(await fs.readFile(path.join(root, CONFIG), "utf8")).toBe("workspace:\n  name: mine\n");
  });

  it("overwrites existing files when --force is passed", async () => {
    await fs.writeFile(path.join(root, IGNORE), "custom-rule\n");

    await initCommand(root, { force: true });

    const ignore = await fs.readFile(path.join(root, IGNORE), "utf8");
    expect(ignore).not.toBe("custom-rule\n");
    expect(ignore).toContain("node_modules/");
  });

  it("throws for a workspace path that does not exist", async () => {
    const missing = path.join(root, "missing");
    await expect(initCommand(missing)).rejects.toThrow(
      new Error(`Path not found for workspace: ${missing}`),
    );
  });
});
