import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({ execa: execaMock }));

import { findAppRoot, retryCommand, updateBinaryUnix } from "../commands/update";

let root: string;

beforeEach(async () => {
  execaMock.mockReset();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-update-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("findAppRoot", () => {
  it("finds the checkout root from a nested bundled file", async () => {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"name":"boot"}');
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    const entry = path.join(root, "dist", "index.js");
    await fs.writeFile(entry, "");

    expect(findAppRoot(entry)).toBe(root);
  });

  it("finds the root from a deeply nested source file", async () => {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"name":"boot"}');
    const deep = path.join(root, "src", "commands", "update.ts");
    await fs.mkdir(path.dirname(deep), { recursive: true });
    await fs.writeFile(deep, "");

    expect(findAppRoot(deep)).toBe(root);
  });

  it("returns null when there's no git checkout above the file", async () => {
    const lone = path.join(root, "nested", "file.js");
    await fs.mkdir(path.dirname(lone), { recursive: true });
    await fs.writeFile(lone, "");

    expect(findAppRoot(lone)).toBeNull();
  });
});

describe("retryCommand", () => {
  it("preserves the --ref option in retry instructions", () => {
    expect(retryCommand({ ref: "v0.1.0" })).toBe("boot update --ref v0.1.0");
  });

  it("omits --ref when updating to the default target", () => {
    expect(retryCommand({})).toBe("boot update");
  });
});

describe("updateBinaryUnix", () => {
  it("propagates installer download failures instead of reporting success", async () => {
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      output.push(String(message ?? ""));
    });
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { stdout: "" };
      if (String(args[1] ?? "").includes("set -o pipefail")) {
        throw new Error("installer download failed");
      }
      return { stdout: "" };
    });

    await expect(updateBinaryUnix({})).rejects.toThrow("installer download failed");

    const installerCall = execaMock.mock.calls.find((call) => call[1]?.[0] === "-c");
    expect(installerCall?.[1]?.[1]).toContain("set -o pipefail");
    expect(output.join("\n")).not.toContain("boot updated");
  });
});
