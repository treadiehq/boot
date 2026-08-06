import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());
const execaCommandMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({ execa: execaMock, execaCommand: execaCommandMock }));

import {
  inspectProcessEnvironment,
  inspectService,
  inspectTools,
  versionSatisfies,
} from "../core/requirements";

describe("requirement inspection", () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaCommandMock.mockReset();
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

  it("prefers a declared check command over the built-in service probe", async () => {
    execaCommandMock.mockResolvedValue({ exitCode: 0, stdout: "accepting connections", stderr: "" });

    await expect(
      inspectService(
        "db",
        { type: "postgres", check: "pg_isready -p 5433" },
        { cwd: "/workspace" },
      ),
    ).resolves.toEqual({
      name: "db",
      required: undefined,
      state: "available",
      observed: "accepting connections",
    });
    expect(execaCommandMock).toHaveBeenCalledWith(
      "pg_isready -p 5433",
      expect.objectContaining({ cwd: "/workspace", shell: true }),
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("checks the running PostgreSQL server version instead of the client version", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "localhost:5432 - accepting connections",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "15.8", stderr: "" });

    await expect(
      inspectService("db", { type: "postgres", version: ">=16" }),
    ).resolves.toEqual({
      name: "db",
      required: ">=16",
      state: "mismatch",
      observed: "15.8",
    });
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "psql",
      [
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--command",
        "SHOW server_version",
      ],
      expect.any(Object),
    );
  });

  it("checks the running Redis server version instead of a local server binary", async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "PONG", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "# Server\nredis_version:6.2.14\nredis_mode:standalone",
        stderr: "",
      });

    await expect(
      inspectService("cache", { type: "redis", version: ">=7" }),
    ).resolves.toEqual({
      name: "cache",
      required: ">=7",
      state: "mismatch",
      observed: "6.2.14",
    });
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "redis-cli",
      ["--raw", "INFO", "server"],
      expect.any(Object),
    );
  });

  it("does not claim availability when a running server version cannot be queried", async () => {
    execaMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "localhost:5432 - accepting connections",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: "password authentication failed",
      });

    await expect(
      inspectService("db", { type: "postgres", version: ">=16" }),
    ).resolves.toMatchObject({
      name: "db",
      required: ">=16",
      state: "unsupported",
      detail: expect.stringContaining("could not verify its server version"),
    });
  });

  it("requires an explicit version check when a custom health check overrides probes", async () => {
    execaCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "accepting connections",
      stderr: "",
    });

    await expect(
      inspectService("db", {
        type: "postgres",
        check: "pg_isready -p 5433",
        version: ">=16",
      }),
    ).resolves.toMatchObject({
      name: "db",
      required: ">=16",
      state: "unsupported",
      detail: expect.stringContaining("add a `versionCheck` command"),
    });
  });

  it("validates custom version check output separately from health output", async () => {
    execaCommandMock
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "accepting connections",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "15.8", stderr: "" });

    await expect(
      inspectService(
        "db",
        {
          type: "postgres",
          check: "pg_isready -p 5433",
          version: ">=16",
          versionCheck: "psql -p 5433 -tAX -c 'SHOW server_version'",
        },
        { cwd: "/workspace" },
      ),
    ).resolves.toEqual({
      name: "db",
      required: ">=16",
      state: "mismatch",
      observed: "15.8",
    });
    expect(execaCommandMock).toHaveBeenNthCalledWith(
      2,
      "psql -p 5433 -tAX -c 'SHOW server_version'",
      expect.objectContaining({ cwd: "/workspace", shell: true }),
    );
  });

  it("reports a failing check command as a missing service", async () => {
    execaCommandMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "no response" });

    await expect(
      inspectService("queue", { check: "nats-cli ping" }),
    ).resolves.toMatchObject({
      name: "queue",
      state: "missing",
      detail: expect.stringContaining('"nats-cli ping"'),
    });
  });

  it("suggests a check command for unsupported service types", async () => {
    await expect(inspectService("search", { type: "opensearch" })).resolves.toMatchObject({
      name: "search",
      state: "unsupported",
      detail: expect.stringContaining('add a "check" command'),
    });
  });
});
