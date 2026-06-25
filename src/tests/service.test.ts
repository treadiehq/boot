import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectServicePlatform,
  installCommands,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceFilePath,
  serviceId,
  uninstallCommands,
  type ServiceSpec,
} from "../core/service";
import { daemonInstall, daemonUninstall, type ServiceRunner } from "../commands/service";

function spec(root: string): ServiceSpec {
  return {
    root,
    node: "/usr/bin/node",
    entry: "/opt/boot/index.js",
    intervalSeconds: 45,
    logFile: path.join(root, ".boot", "daemon.log"),
    errFile: path.join(root, ".boot", "daemon.err.log"),
    pathEnv: "/opt/homebrew/bin:/usr/bin",
  };
}

describe("service platform + identity", () => {
  it("maps platforms to managers", () => {
    expect(detectServicePlatform("darwin")).toBe("launchd");
    expect(detectServicePlatform("linux")).toBe("systemd");
    expect(detectServicePlatform("win32")).toBeNull();
  });

  it("derives a stable id that varies by root", () => {
    expect(serviceId("/Users/me/code")).toBe(serviceId("/Users/me/code"));
    expect(serviceId("/Users/me/code")).not.toBe(serviceId("/Users/me/other"));
  });

  it("places files in the expected per-user locations", () => {
    const ld = serviceFilePath("launchd", "/Users/me/code", "/Users/me");
    expect(ld).toMatch(/Library\/LaunchAgents\/com\.openboot\.[0-9a-f]+\.plist$/);
    const sd = serviceFilePath("systemd", "/home/me/code", "/home/me");
    expect(sd).toMatch(/\.config\/systemd\/user\/boot-[0-9a-f]+\.service$/);
  });
});

describe("renderers", () => {
  it("renders a launchd plist with the full program arguments", () => {
    const plist = renderLaunchdPlist("/Users/me/code", spec("/Users/me/code"));
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("com.openboot.");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>/opt/boot/index.js</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>45</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("daemon.log");
  });

  it("renders a systemd unit with restart + exec", () => {
    const unit = renderSystemdUnit("/home/me/code", spec("/home/me/code"));
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /opt/boot/index.js daemon start /home/me/code --interval 45",
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Environment=PATH=/opt/homebrew/bin:/usr/bin");
  });

  it("quotes systemd exec arguments that contain spaces", () => {
    const withSpace = { ...spec("/home/me/my code"), root: "/home/me/my code" };
    const unit = renderSystemdUnit("/home/me/my code", withSpace);
    expect(unit).toContain('"/home/me/my code"');
  });
});

describe("command plans", () => {
  it("plans launchd load + idempotent pre-bootout", () => {
    const cmds = installCommands("launchd", "/Users/me/code", "/path/to.plist", 501);
    expect(cmds[0]).toMatchObject({ ignoreError: true });
    expect(cmds[0]?.argv).toContain("bootout");
    expect(cmds.some((c) => c.argv.includes("bootstrap") && c.argv.includes("/path/to.plist"))).toBe(true);
  });

  it("plans systemd enable --now and tolerant uninstall", () => {
    const install = installCommands("systemd", "/home/me/code", "/x.service", 1000);
    expect(install[0]?.argv).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(install[1]?.argv.slice(0, 4)).toEqual(["systemctl", "--user", "enable", "--now"]);

    const remove = uninstallCommands("systemd", "/home/me/code", 1000);
    expect(remove[0]?.ignoreError).toBe(true);
    expect(remove[0]?.argv).toContain("disable");
  });
});

describe("install / uninstall (injected runner)", () => {
  let root: string;
  let home: string;
  let calls: string[][];
  let runner: ServiceRunner;

  beforeEach(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "boot-service-"));
    root = path.join(tmp, "code");
    home = path.join(tmp, "home");
    // A linked workspace just needs its map dir to exist.
    await fs.mkdir(path.join(root, ".boot", "map"), { recursive: true });
    calls = [];
    runner = async (argv: string[]) => {
      calls.push(argv);
      return { exitCode: 0, output: "" };
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it("writes a systemd unit and runs enable, then removes it on uninstall", async () => {
    await daemonInstall(root, {
      platform: "systemd",
      home,
      runner,
      intervalSeconds: 30,
      node: "/usr/bin/node",
      entry: "/opt/boot/index.js",
      pathEnv: "/usr/bin",
    });

    const file = serviceFilePath("systemd", root, home);
    expect(existsSync(file)).toBe(true);
    const content = await fs.readFile(file, "utf8");
    expect(content).toContain("daemon start");
    expect(content).toContain("--interval 30");

    expect(calls.some((c) => c.join(" ") === "systemctl --user daemon-reload")).toBe(true);
    expect(calls.some((c) => c.join(" ").startsWith("systemctl --user enable --now"))).toBe(true);

    calls.length = 0;
    await daemonUninstall(root, { platform: "systemd", home, runner });

    expect(existsSync(file)).toBe(false);
    expect(calls.some((c) => c.includes("disable"))).toBe(true);
  });

  it("writes a launchd plist and runs bootstrap", async () => {
    await daemonInstall(root, {
      platform: "launchd",
      home,
      runner,
      node: "/usr/bin/node",
      entry: "/opt/boot/index.js",
      pathEnv: "/usr/bin",
    });

    const file = serviceFilePath("launchd", root, home);
    expect(existsSync(file)).toBe(true);
    expect(calls.some((c) => c.includes("bootstrap"))).toBe(true);
  });

  it("refuses to install for an unlinked workspace", async () => {
    const unlinked = path.join(path.dirname(root), "nope");
    await fs.mkdir(unlinked, { recursive: true });
    await expect(
      daemonInstall(unlinked, { platform: "systemd", home, runner }),
    ).rejects.toThrow(/not linked/);
  });
});
