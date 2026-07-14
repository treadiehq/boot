import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, loadConfig, parseConfig, resolveConfig } from "../core/config";

const SAMPLE = `workspace:
  name: dante-code
hydrate:
  strategy: manual
ignore:
  - node_modules
  - .next
doctor:
  defaultBranchNames:
    - main
    - master
  staleAfterDays: 14
`;

describe("parseConfig", () => {
  it("parses a valid config", () => {
    const file = parseConfig(SAMPLE);
    expect(file.workspace?.name).toBe("dante-code");
    expect(file.hydrate?.strategy).toBe("manual");
    expect(file.ignore).toEqual(["node_modules", ".next"]);
    expect(file.doctor?.staleAfterDays).toBe(14);
  });

  it("treats an empty document as an empty config", () => {
    expect(parseConfig("")).toEqual({});
  });

  it("rejects an unknown hydrate strategy", () => {
    expect(() => parseConfig("hydrate:\n  strategy: turbo\n")).toThrow(
      new Error(
        "boot.yaml has an invalid format (root: Invalid input). Fix the file, then retry.",
      ),
    );
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseConfig("nope: true\n")).toThrow(
      new Error(
        "boot.yaml has an invalid format (root: Invalid input). Fix the file, then retry.",
      ),
    );
  });

  it("rejects invalid YAML", () => {
    expect(() => parseConfig("foo: : :\n  - bad")).toThrow(
      new Error(
        "boot.yaml is not valid YAML: Nested mappings are not allowed in compact mappings at line 1, column 6: foo: : : ^ Fix the file, then retry.",
      ),
    );
  });
});

describe("resolveConfig", () => {
  it("applies defaults for missing fields", () => {
    const resolved = resolveConfig({}, null);
    expect(resolved).toEqual(DEFAULT_CONFIG);
  });

  it("overlays file values on top of defaults", () => {
    const resolved = resolveConfig(parseConfig(SAMPLE), "boot.yaml");
    expect(resolved.workspaceName).toBe("dante-code");
    expect(resolved.hydrateStrategy).toBe("manual");
    expect(resolved.staleAfterDays).toBe(14);
    expect(resolved.defaultBranchNames).toEqual(["main", "master"]);
    expect(resolved.sourcePath).toBe(CONFIG_FILE_NAME);
  });
});

describe("loadConfig", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-config-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    const resolved = await loadConfig(root);
    expect(resolved).toEqual(DEFAULT_CONFIG);
  });

  it("loads the config file when present", async () => {
    await fs.writeFile(path.join(root, CONFIG_FILE_NAME), SAMPLE);
    const resolved = await loadConfig(root);
    expect(resolved.workspaceName).toBe("dante-code");
    expect(resolved.hydrateStrategy).toBe("manual");
    expect(resolved.sourcePath).toBe(CONFIG_FILE_NAME);
  });
});
