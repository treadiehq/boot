import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findAppRoot } from "../commands/update";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-update-"));
});
afterEach(async () => {
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
