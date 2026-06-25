import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setupCommand } from "../commands/setup";
import { keyExists } from "../core/secrets";
import { isLinked } from "../core/map";
import { rcPathFor, hookInstalledIn } from "../core/health";
import { serviceFilePath } from "../core/service";
import type { ServiceRunner } from "../commands/service";

function gitUsable(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(path.join(os.tmpdir(), "boot-gitprobe-"));
    execFileSync("git", ["init", "-q"], { cwd: probe, stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

const GIT_OK = gitUsable();

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
function bare(repoPath: string): void {
  execFileSync("git", ["init", "-q", "--bare", repoPath], { stdio: "pipe" });
}

async function makeRepo(root: string, dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "tester");
  await fs.writeFile(path.join(dir, "package.json"), `{"name":"${name}"}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const remote = path.join(root, `${name}.git`);
  bare(remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
}

describe.skipIf(!GIT_OK)("boot setup wizard (e2e)", () => {
  let root: string;
  let mapRemote: string;
  let home: string;
  let ws: string;
  let runnerCalls: string[][];
  const prevHome = process.env.BOOT_HOME;
  const prevShell = process.env.SHELL;

  const runner: ServiceRunner = async (argv) => {
    runnerCalls.push(argv);
    return { exitCode: 0, output: "" };
  };

  async function runSetup(remote: string | undefined, opts: Record<string, unknown>): Promise<void> {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await setupCommand(remote, ws, {
        yes: true,
        shell: "zsh",
        home,
        platform: "launchd",
        serviceRunner: runner,
        entry: "/usr/local/bin/boot",
        ...opts,
      });
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-setup-"));
    mapRemote = path.join(root, "map.git");
    bare(mapRemote);
    home = path.join(root, "home");
    ws = path.join(root, "ws");
    runnerCalls = [];
    process.env.BOOT_HOME = path.join(root, "state");
    process.env.SHELL = "/bin/zsh";
    await makeRepo(root, path.join(ws, "apps", "api"), "api");
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    process.env.SHELL = prevShell;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("wires up link, key, hook, and the managed daemon in one shot", async () => {
    await runSetup(mapRemote, {});

    // Linked.
    expect(isLinked(ws)).toBe(true);
    // Secret key created (first machine, no existing scopes).
    expect(keyExists()).toBe(true);
    // Shell hook appended to the rc in the injected home.
    expect(hookInstalledIn(rcPathFor("zsh", home))).toBe(true);
    // Managed service file written + loaded via the (fake) launchctl runner.
    expect(existsSync(serviceFilePath("launchd", ws, home))).toBe(true);
    expect(runnerCalls.some((c) => c[0] === "launchctl")).toBe(true);
  });

  it("is idempotent: re-running pulls and doesn't duplicate the hook", async () => {
    await runSetup(mapRemote, {});

    const rc = await fs.readFile(rcPathFor("zsh", home), "utf8");
    const occurrences = rc.split("boot shell-hook").length - 1;
    expect(occurrences).toBe(1);
    expect(isLinked(ws)).toBe(true);
  });

  it("honors --no-* opt-outs", async () => {
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "boot-setup2-"));
    const home2 = path.join(root2, "home");
    const ws2 = path.join(root2, "ws");
    const state2 = path.join(root2, "state");
    const map2 = path.join(root2, "map.git");
    bare(map2);
    await makeRepo(root2, path.join(ws2, "apps", "web"), "web");

    process.env.BOOT_HOME = state2;
    const calls: string[][] = [];
    const localRunner: ServiceRunner = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, output: "" };
    };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await setupCommand(map2, ws2, {
        yes: true,
        shell: "zsh",
        home: home2,
        platform: "launchd",
        serviceRunner: localRunner,
        entry: "/usr/local/bin/boot",
        hook: false,
        daemon: false,
        key: false,
      });
    } finally {
      spy.mockRestore();
      process.env.BOOT_HOME = path.join(root, "state");
    }

    expect(isLinked(ws2)).toBe(true); // still links
    expect(existsSync(path.join(state2, "secret.key"))).toBe(false); // --no-key
    expect(hookInstalledIn(rcPathFor("zsh", home2))).toBe(false); // --no-hook
    expect(existsSync(serviceFilePath("launchd", ws2, home2))).toBe(false); // --no-daemon
    expect(calls.length).toBe(0);

    await fs.rm(root2, { recursive: true, force: true });
  });
});
