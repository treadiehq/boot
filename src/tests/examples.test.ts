import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parseConfig, resolveConfig } from "../core/config";

describe("example Workspaces", () => {
  it.each(["billing", "shared-workspace"])("keeps the %s manifest valid", async (name) => {
    const raw = await fs.readFile(
      path.join(process.cwd(), "examples", name, "boot.yaml"),
      "utf8",
    );
    const resolved = resolveConfig(parseConfig(raw), "boot.yaml");
    expect(resolved.definition?.schemaVersion).toBe(1);
    expect(Object.keys(resolved.definition?.repositories ?? {}).length).toBeGreaterThan(0);
  });
});
