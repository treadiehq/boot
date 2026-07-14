import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.hoisted(() => vi.fn());

vi.mock("execa", () => ({ execa: execaMock }));

import { cloneRepo } from "../core/git";

describe("user-facing Git failures", () => {
  beforeEach(() => {
    execaMock.mockReset();
  });

  it("keeps an actionable reason without exposing credentials or terminal output", async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr:
        "\u001b[31mfatal: Authentication failed for 'https://token@example.com/private.git'\u001b[0m\nAuthorization: Bearer secret",
    });

    let message = "";
    try {
      await cloneRepo(
        "https://user:password@example.com/private.git",
        "/tmp/workspace with spaces/private",
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Could not download repository");
    expect(message).toContain("Authentication failed");
    expect(message).toContain("Check the repository URL and your access");
    expect(message).not.toContain("user:password");
    expect(message).not.toContain("token@");
    expect(message).not.toContain("Bearer secret");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\n");
  });
});
