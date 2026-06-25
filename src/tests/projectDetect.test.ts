import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectPackageManager,
  detectProject,
  detectProjectType,
} from "../core/projectDetect";

describe("detectPackageManager", () => {
  it("prefers lockfiles", () => {
    expect(detectPackageManager(new Set(["pnpm-lock.yaml"]))).toBe("pnpm");
    expect(detectPackageManager(new Set(["yarn.lock"]))).toBe("yarn");
    expect(detectPackageManager(new Set(["bun.lock"]))).toBe("bun");
    expect(detectPackageManager(new Set(["bun.lockb"]))).toBe("bun");
    expect(detectPackageManager(new Set(["package-lock.json"]))).toBe("npm");
  });

  it("falls back to the package.json packageManager field", () => {
    expect(detectPackageManager(new Set(["package.json"]), "yarn@4.1.0")).toBe("yarn");
    expect(detectPackageManager(new Set(["package.json"]), "pnpm@9.0.0")).toBe("pnpm");
  });

  it("returns null when nothing is detectable", () => {
    expect(detectPackageManager(new Set(["package.json"]))).toBeNull();
    expect(detectPackageManager(new Set())).toBeNull();
  });
});

describe("detectProjectType", () => {
  it("maps marker files to project types", () => {
    expect(detectProjectType(new Set(["package.json"]))).toBe("node");
    expect(detectProjectType(new Set(["requirements.txt"]))).toBe("python");
    expect(detectProjectType(new Set(["pyproject.toml"]))).toBe("python");
    expect(detectProjectType(new Set(["go.mod"]))).toBe("go");
    expect(detectProjectType(new Set(["Cargo.toml"]))).toBe("rust");
    expect(detectProjectType(new Set(["readme.md"]))).toBe("unknown");
  });
});

describe("detectProject (filesystem)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-detect-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects a node + pnpm project with ignore hints", async () => {
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "");
    await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");
    await fs.mkdir(path.join(dir, "node_modules"));
    await fs.mkdir(path.join(dir, "dist"));

    const info = await detectProject(dir);

    expect(info.projectType).toBe("node");
    expect(info.packageManager).toBe("pnpm");
    expect(info.detectedFiles).toContain("package.json");
    expect(info.detectedFiles).toContain("tsconfig.json");
    expect(info.ignoredHints).toEqual(["dist", "node_modules"]);
  });

  it("reads the packageManager field when no lockfile is present", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", packageManager: "yarn@4.1.0" }),
    );

    const info = await detectProject(dir);
    expect(info.projectType).toBe("node");
    expect(info.packageManager).toBe("yarn");
  });

  it("detects a rust project", async () => {
    await fs.writeFile(path.join(dir, "Cargo.toml"), "");
    await fs.writeFile(path.join(dir, "Cargo.lock"), "");

    const info = await detectProject(dir);
    expect(info.projectType).toBe("rust");
    expect(info.packageManager).toBeNull();
    expect(info.detectedFiles).toContain("Cargo.toml");
  });
});
