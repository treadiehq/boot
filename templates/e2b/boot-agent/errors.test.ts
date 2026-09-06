import { CommandExitError, Sandbox } from "e2b";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatE2BError } from "./errors";

vi.mock("e2b", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("e2b")>();
  return { ...sdk, Sandbox: { create: vi.fn() } };
});

describe("E2B error diagnostics", () => {
  it("reports the exit code and captured output from the real SDK error", () => {
    const error = new CommandExitError({
      exitCode: 6,
      error: "exit status 6",
      stderr: "curl: (6) Could not resolve host: useboot.co\n",
      stdout: "Boot Agent Bootstrap\nCloning workspace...\n",
    });

    expect(formatE2BError(error)).toBe(
      "Command exited with code 6\n" +
        "stderr: curl: (6) Could not resolve host: useboot.co\n" +
        "stdout: Boot Agent Bootstrap Cloning workspace...",
    );
  });

  it("omits empty output and handles an SDK error without a message", () => {
    const error = new CommandExitError({
      exitCode: 1,
      stderr: " \n\t",
      stdout: "",
    });

    expect(formatE2BError(error)).toBe("Command exited with code 1");
  });

  it("retains stdout diagnostics when stderr is empty", () => {
    const diagnostics = '{"ready":false,"blockers":["Repository not found"]}';
    const error = new CommandExitError({
      exitCode: 1,
      stderr: "",
      stdout: diagnostics,
    });

    expect(formatE2BError(error)).toBe(
      `Command exited with code 1\nstdout: ${diagnostics}`,
    );
  });

  it("preserves a descriptive SDK message when command output is unavailable", () => {
    const error = new CommandExitError({
      exitCode: 1,
      error: "Failed to start process: permission denied",
      stderr: "",
      stdout: "",
    });

    expect(formatE2BError(error)).toBe(
      "Command exited with code 1: Failed to start process: permission denied",
    );
  });

  it("redacts credentials and terminal controls in both output streams", () => {
    const error = new CommandExitError({
      exitCode: 128,
      stderr:
        "\u001b[31mfatal: authentication failed for https://test-user:test-password@example.com/repo.git\u001b[0m",
      stdout: "Authorization: Bearer test-token\n",
    });

    expect(formatE2BError(error)).toBe(
      "Command exited with code 128\n" +
        "stderr: fatal: authentication failed for https://example.com/repo.git\n" +
        "stdout: Authorization: Bearer [redacted]",
    );
  });

  it("keeps a failure reason after lengthy command output", () => {
    const error = new CommandExitError({
      exitCode: 1,
      stderr: `${"Cloning workspace...\n".repeat(300)}fatal: repository not found`,
      stdout: "",
    });

    expect(formatE2BError(error)).toContain("fatal: repository not found");
  });

  it.each([
    [new Error("E2B_API_KEY is required."), "E2B_API_KEY is required."],
    ["Connection failed", "Connection failed"],
    [null, "null"],
    [42, "42"],
  ])(
    "keeps the fallback for ordinary errors and thrown values: %s",
    (error, message) => {
      expect(formatE2BError(error)).toBe(message);
    },
  );
});

describe("E2B script failure reporting", () => {
  const run = vi.fn();
  const kill = vi.fn();
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    run.mockReset();
    kill.mockReset().mockResolvedValue(undefined);
    vi.mocked(Sandbox.create).mockReset().mockResolvedValue({
      sandboxId: "test-sandbox",
      commands: { run },
      kill,
    } as unknown as Sandbox);
    for (const [name, value] of Object.entries({
      E2B_API_KEY: "test-only",
      E2B_TEMPLATE: "boot-agent-test",
      E2B_TIMEOUT_MS: "",
      BOOT_MAP: "https://github.com/example/workspace-map.git",
      BOOT_WORKSPACE: "/home/user/workspace",
      BOOT_PROFILE: "agent",
      BOOT_MAP_COMMIT: "",
      BOOT_NO_ENV: "1",
      BOOT_SSH_PRIVATE_KEY_FILE: "",
      BOOT_SSH_KNOWN_HOSTS_FILE: "",
      BOOT_SECRET_KEY_FILE: "",
    })) {
      vi.stubEnv(name, value);
    }
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["bootstrap", "inspection", "smoke"])(
    "reports %s command diagnostics, exits unsuccessfully, and kills the sandbox",
    async (stage) => {
      if (stage === "inspection") {
        run.mockResolvedValueOnce({
          exitCode: 0,
          stdout: '{"ready":true}',
          stderr: "",
        });
      }
      run.mockRejectedValueOnce(
        new CommandExitError({
          exitCode: 1,
          error: "exit status 1",
          stderr: "fatal: repository not found\n",
          stdout: "Checking workspace...\n",
        }),
      );

      if (stage === "smoke") {
        await import("./smoke");
      } else {
        await import("./launch");
      }

      const label = stage === "smoke" ? "smoke check" : "launch";
      await vi.waitFor(() => {
        expect(process.stderr.write).toHaveBeenCalledWith(
          `E2B ${label} failed: Command exited with code 1\n` +
            "stderr: fatal: repository not found\n" +
            "stdout: Checking workspace...\n",
        );
      });
      expect(process.exitCode).toBe(1);
      expect(process.stdout.write).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledTimes(stage === "inspection" ? 2 : 1);
    },
  );

  it("reports validation errors before creating a sandbox", async () => {
    vi.stubEnv("E2B_API_KEY", "");

    await import("./launch");

    await vi.waitFor(() => {
      expect(process.stderr.write).toHaveBeenCalledWith(
        "E2B launch failed: E2B_API_KEY is required.\n",
      );
    });
    expect(process.exitCode).toBe(1);
    expect(Sandbox.create).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps successful launch output as JSON and leaves the sandbox running", async () => {
    const bootstrap = { ready: true };
    const inspection = { workspace: { ready: true }, blockers: [] };
    run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify(bootstrap),
      stderr: "",
    });
    run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify(inspection),
      stderr: "",
    });

    await import("./launch");

    await vi.waitFor(() => expect(process.stdout.write).toHaveBeenCalledOnce());
    const output = vi.mocked(process.stdout.write).mock.calls[0][0];
    expect(JSON.parse(String(output))).toEqual({
      sandboxId: "test-sandbox",
      workspace: "/home/user/workspace",
      bootstrap,
      inspection,
    });
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });
});
