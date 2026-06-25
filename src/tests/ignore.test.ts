import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createIgnoreMatcher,
  IGNORE_FILE_NAME,
  loadIgnoreFileEntry,
  parseIgnoreContent,
} from "../core/ignore";

describe("parseIgnoreContent", () => {
  it("drops blank lines and comments, trims whitespace", () => {
    const rules = parseIgnoreContent(
      ["# a comment", "", "  node_modules/  ", ".env", "   ", "*.log"].join("\n"),
    );
    expect(rules).toEqual(["node_modules/", ".env", "*.log"]);
  });
});

describe("createIgnoreMatcher", () => {
  it("matches directory-only rules against directories", () => {
    const m = createIgnoreMatcher(["node_modules/", "dist/"]);
    expect(m.isIgnored("node_modules", true)).toBe(true);
    expect(m.isIgnored("dist", true)).toBe(true);
    // A *file* named like a dir rule should not match a dir-only rule.
    expect(m.isIgnored("node_modules", false)).toBe(false);
  });

  it("matches exact file names regardless of type", () => {
    const m = createIgnoreMatcher([".env", ".env.local"]);
    expect(m.isIgnored(".env", false)).toBe(true);
    expect(m.isIgnored(".env.local", false)).toBe(true);
    expect(m.isIgnored(".environment", false)).toBe(false);
  });

  it("supports simple globs", () => {
    const m = createIgnoreMatcher(["*.log"]);
    expect(m.isIgnored("debug.log", false)).toBe(true);
    expect(m.isIgnored("error.log", false)).toBe(true);
    expect(m.isIgnored("log", false)).toBe(false);
  });

  it("deduplicates rules", () => {
    const m = createIgnoreMatcher(["dist/", "dist/", ".env"]);
    expect(m.rules).toEqual(["dist/", ".env"]);
  });
});

describe("loadIgnoreFileEntry", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-ignore-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null when no ignore file is present", async () => {
    expect(await loadIgnoreFileEntry(root, root, "workspace")).toBeNull();
  });

  it("reads workspace-scoped rules with a portable relative path", async () => {
    await fs.writeFile(path.join(root, IGNORE_FILE_NAME), "node_modules/\n*.log\n");
    const entry = await loadIgnoreFileEntry(root, root, "workspace");
    expect(entry).toEqual({
      path: IGNORE_FILE_NAME,
      scope: "workspace",
      rules: ["node_modules/", "*.log"],
    });
  });

  it("reads repo-scoped rules with a nested relative path", async () => {
    const repo = path.join(root, "apps", "kplane");
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, IGNORE_FILE_NAME), ".env\n");
    const entry = await loadIgnoreFileEntry(root, repo, "repo");
    expect(entry?.scope).toBe("repo");
    expect(entry?.path).toBe(`apps/kplane/${IGNORE_FILE_NAME}`);
    expect(entry?.path).not.toContain("\\");
    expect(entry?.rules).toEqual([".env"]);
  });
});
