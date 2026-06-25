import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectShell, renderShellHook, shellHookCommand } from "../commands/shellHook";

describe("renderShellHook", () => {
  it("emits a zsh chpwd hook that calls `boot enter`", () => {
    const out = renderShellHook("zsh");
    expect(out).toContain("add-zsh-hook chpwd _boot_autohydrate");
    expect(out).toContain('boot enter "$PWD" --quiet');
  });

  it("emits a bash PROMPT_COMMAND hook that is idempotent", () => {
    const out = renderShellHook("bash");
    expect(out).toContain("PROMPT_COMMAND");
    expect(out).toContain("_boot_autohydrate");
    // Guard prevents double-registration.
    expect(out).toContain('*";_boot_autohydrate;"*) ;;');
  });

  it("emits a fish --on-variable PWD hook", () => {
    const out = renderShellHook("fish");
    expect(out).toContain("--on-variable PWD");
    expect(out).toContain('boot enter "$PWD" --quiet');
  });
});

describe("detectShell", () => {
  const original = process.env.SHELL;
  afterEach(() => {
    process.env.SHELL = original;
  });

  it("detects zsh from $SHELL", () => {
    process.env.SHELL = "/bin/zsh";
    expect(detectShell()).toBe("zsh");
  });

  it("returns null for an unknown shell", () => {
    process.env.SHELL = "/usr/bin/nu";
    expect(detectShell()).toBeNull();
  });
});

describe("shellHookCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints the snippet for an explicit shell", () => {
    shellHookCommand("bash");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(String(logSpy.mock.calls[0][0])).toContain("_boot_autohydrate");
  });

  it("throws on an unsupported shell", () => {
    expect(() => shellHookCommand("powershell")).toThrow(/Unsupported shell/);
  });
});
