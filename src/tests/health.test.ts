import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canLoadFuse,
  collectHealth,
  hookEvalLine,
  hookInstalledIn,
  rcPathFor,
} from "../core/health";
import { doctorCommand } from "../commands/doctor";

let tmp: string;
const prevHome = process.env.BOOT_HOME;
const prevShell = process.env.SHELL;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "boot-health-"));
  process.env.BOOT_HOME = path.join(tmp, "state");
  process.env.SHELL = "/bin/zsh";
});

afterEach(async () => {
  process.env.BOOT_HOME = prevHome;
  process.env.SHELL = prevShell;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("rc + hook helpers", () => {
  it("maps shells to rc paths", () => {
    const home = "/home/x";
    expect(rcPathFor("zsh", home)).toBe(path.join(home, ".zshrc"));
    expect(rcPathFor("bash", home)).toBe(path.join(home, ".bashrc"));
    expect(rcPathFor("fish", home)).toBe(path.join(home, ".config", "fish", "config.fish"));
  });

  it("renders the right eval line per shell", () => {
    expect(hookEvalLine("zsh")).toBe('eval "$(boot shell-hook zsh)"');
    expect(hookEvalLine("fish")).toBe("boot shell-hook fish | source");
  });

  it("detects whether an rc file already sources the hook", async () => {
    const rc = path.join(tmp, ".zshrc");
    expect(hookInstalledIn(rc)).toBe(false);
    await fs.writeFile(rc, 'export X=1\neval "$(boot shell-hook zsh)"\n');
    expect(hookInstalledIn(rc)).toBe(true);
  });

  it("canLoadFuse returns a boolean", () => {
    expect(typeof canLoadFuse()).toBe("boolean");
  });
});

describe("collectHealth", () => {
  it("reports an unconfigured workspace", async () => {
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    const root = path.join(tmp, "ws");
    await fs.mkdir(root, { recursive: true });

    const health = await collectHealth(root, { home, platform: null });
    expect(health.linked).toBe(false);
    expect(health.keyPresent).toBe(false);
    expect(health.shell).toBe("zsh");
    expect(health.hookInstalled).toBe(false);
    expect(health.serviceInstalled).toBe(false);
    expect(health.daemonRunning).toBe(false);
  });

  it("sees the key and the installed hook once present", async () => {
    const home = path.join(tmp, "home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(rcPathFor("zsh", home), 'eval "$(boot shell-hook zsh)"\n');

    // A 32-byte base64 key file where stateDir() expects it.
    await fs.mkdir(process.env.BOOT_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.BOOT_HOME!, "secret.key"),
      `${Buffer.alloc(32, 7).toString("base64")}\n`,
    );

    const root = path.join(tmp, "ws");
    await fs.mkdir(root, { recursive: true });

    const health = await collectHealth(root, { home, platform: null });
    expect(health.keyPresent).toBe(true);
    expect(health.hookInstalled).toBe(true);
  });
});

describe("doctor --system", () => {
  it("prints a setup-health checklist instead of scanning repos", async () => {
    const root = path.join(tmp, "ws");
    await fs.mkdir(root, { recursive: true });

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      lines.push(String(m ?? ""));
    });
    try {
      await doctorCommand(root, { system: true });
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain("Setup health");
    expect(out).toMatch(/Linked/);
    expect(out).toMatch(/Secret key/);
  });
});
