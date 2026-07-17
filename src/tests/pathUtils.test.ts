import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWithinRoot } from "../core/pathUtils";

describe("resolveWithinRoot", () => {
  it("resolves a portable path beneath a workspace", () => {
    const root = path.resolve("workspace");

    expect(resolveWithinRoot(root, "apps/web")).toBe(path.join(root, "apps", "web"));
  });

  it("accepts valid paths when the workspace is the filesystem root", () => {
    const filesystemRoot = path.parse(process.cwd()).root;

    expect(resolveWithinRoot(filesystemRoot, "apps/web")).toBe(
      path.resolve(filesystemRoot, "apps", "web"),
    );
  });

  it("rejects traversal outside the workspace", () => {
    expect(() => resolveWithinRoot(path.resolve("workspace"), "../outside")).toThrow(
      /must be normalized and must not contain '\.\.'/,
    );
  });
});
