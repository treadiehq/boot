import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({ execa: execaMock }));

import {
  inspectProcessEnvironment,
  inspectTools,
  versionSatisfies,
} from "../core/requirements";

describe("requirement inspection", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("matches common runtime version expressions", () => {
    expect(versionSatisfies("v24.3.1", "24")).toBe(true);
    expect(versionSatisfies("v24.3.1", ">=24")).toBe(true);
    expect(versionSatisfies("v22.9.0", ">=24")).toBe(false);
    expect(versionSatisfies("pnpm 10.4.0", "^10.2")).toBe(true);
    expect(versionSatisfies("pnpm 11.0.0", "^10.2")).toBe(false);
  });

  it("reports availability without exposing values", () => {
    const previous = process.env.BOOT_REQUIREMENT_TEST;
    process.env.BOOT_REQUIREMENT_TEST = "do-not-expose";
    try {
      const statuses = inspectProcessEnvironment([
        { name: "BOOT_REQUIREMENT_TEST", secret: true },
        { name: "FROM_BOOT", secret: true, source: "boot" },
      ], new Set(["FROM_BOOT"]));
      expect(statuses).toEqual([
        {
          name: "BOOT_REQUIREMENT_TEST",
          secret: true,
          source: undefined,
          available: true,
          availableFrom: "process",
        },
        {
          name: "FROM_BOOT",
          secret: true,
          source: "boot",
          available: true,
          availableFrom: "boot",
        },
      ]);
      expect(JSON.stringify(statuses)).not.toContain("do-not-expose");
    } finally {
      if (previous === undefined) delete process.env.BOOT_REQUIREMENT_TEST;
      else process.env.BOOT_REQUIREMENT_TEST = previous;
    }
  });

  it("reports when a required binary is missing from PATH", async () => {
    execaMock.mockResolvedValue({
      exitCode: undefined,
      code: "ENOENT",
      stdout: "",
      stderr: "",
    });

    await expect(inspectTools({ pnpm: ">=10" })).resolves.toEqual([
      {
        name: "pnpm",
        required: ">=10",
        state: "missing",
        detail: '"pnpm" was not found on PATH; install it, then retry',
      },
    ]);
  });
});
