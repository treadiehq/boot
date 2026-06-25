import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectServicePlatform,
  installCommands,
  programArguments,
  renderLaunchdPlist,
  renderSchtasksXml,
  renderSystemdUnit,
  scheduledTaskName,
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
    expect(detectServicePlatform("win32")).toBe("schtasks");
    expect(detectServicePlatform("freebsd")).toBeNull();
  });

  it("derives a stable id that varies by root", () => {
    expect(serviceId("/Users/me/code")).toBe(serviceId("/Users/me/code"));
    expect(serviceId("/Users/me/code")).not.toBe(serviceId("/Users/me/other"));
  });

  it("places files in the expected per-user locations", () => {
    const ld = serviceFilePath("launchd", "/Users/me/code", "/Users/me");
    expect(ld).toMatch(/Library\/LaunchAgents\/com\.boot\.[0-9a-f]+\.plist$/);
    const sd = serviceFilePath("systemd", "/home/me/code", "/home/me");
    expect(sd).toMatch(/\.config\/systemd\/user\/boot-[0-9a-f]+\.service$/);
    const win = serviceFilePath("schtasks", "C:\\Users\\me\\code", "C:\\Users\\me");
    expect(win).toContain(".boot");
    expect(win).toMatch(/boot-[0-9a-f]+\.xml$/);
  });
});

describe("program arguments", () => {
  it("includes the script for a source install", () => {
    expect(programArguments(spec("/home/me/code"))).toEqual([
      "/usr/bin/node",
      "/opt/boot/index.js",
      "daemon",
      "start",
      "/home/me/code",
      "--interval",
      "45",
    ]);
  });

  it("drops the script for a standalone binary (empty entry)", () => {
    const standalone: ServiceSpec = { ...spec("/home/me/code"), node: "/usr/local/bin/boot", entry: "" };
    expect(programArguments(standalone)).toEqual([
      "/usr/local/bin/boot",
      "daemon",
      "start",
      "/home/me/code",
      "--interval",
      "45",
    ]);
  });
});

describe("renderers", () => {
  it("renders a launchd plist with the full program arguments", () => {
    const plist = renderLaunchdPlist("/Users/me/code", spec("/Users/me/code"));
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("com.boot.");
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

  it("renders a Task Scheduler XML that runs the boot binary directly", () => {
    const root = "C:\\Users\\me\\code";
    const winSpec: ServiceSpec = {
      ...spec(root),
      root,
      node: "C:\\Users\\me\\AppData\\Local\\boot\\bin\\boot.exe",
      entry: "",
    };
    const xml = renderSchtasksXml(root, winSpec);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<Command>C:\\Users\\me\\AppData\\Local\\boot\\bin\\boot.exe</Command>");
    expect(xml).toContain("<Arguments>daemon start C:\\Users\\me\\code --interval 45</Arguments>");
    expect(xml).toContain("<RestartOnFailure>");
  });

  it("quotes Task Scheduler arguments that contain spaces", () => {
    const root = "C:\\Users\\me\\my code";
    const winSpec: ServiceSpec = { ...spec(root), root, node: "C:\\boot.exe", entry: "" };
    const xml = renderSchtasksXml(root, winSpec);
    expect(xml).toContain('"C:\\Users\\me\\my code"');
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

  it("plans schtasks create (idempotent /F) + run, and tolerant delete", () => {
    const root = "C:\\Users\\me\\code";
    const task = scheduledTaskName(root);
    const install = installCommands("schtasks", root, "C:\\path\\to.xml", 0);
    expect(install[0]?.argv).toEqual(["schtasks", "/Create", "/TN", task, "/XML", "C:\\path\\to.xml", "/F"]);
    expect(install.some((c) => c.argv.includes("/Run"))).toBe(true);

    const remove = uninstallCommands("schtasks", root, 0);
    expect(remove.every((c) => c.ignoreError)).toBe(true);
    expect(remove.some((c) => c.argv.includes("/Delete") && c.argv.includes(task))).toBe(true);
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
