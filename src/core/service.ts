import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/** OS service managers boot knows how to install into. */
export type ServicePlatform = "launchd" | "systemd" | "schtasks";

/** Map a Node platform to its service manager, or null when unsupported. */
export function detectServicePlatform(
  platform: NodeJS.Platform = process.platform,
): ServicePlatform | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  if (platform === "win32") return "schtasks";
  return null;
}

/** Stable per-workspace id derived from the absolute root path. */
export function serviceId(root: string): string {
  return crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 10);
}

export function launchdLabel(root: string): string {
  return `com.boot.${serviceId(root)}`;
}

export function systemdUnitName(root: string): string {
  return `boot-${serviceId(root)}`;
}

/** Windows Task Scheduler task name for a workspace. */
export function scheduledTaskName(root: string): string {
  return `boot-${serviceId(root)}`;
}

/** Platform-appropriate service identifier (launchd label, systemd unit, or task name). */
export function serviceName(platform: ServicePlatform, root: string): string {
  if (platform === "launchd") return launchdLabel(root);
  if (platform === "systemd") return systemdUnitName(root);
  return scheduledTaskName(root);
}

/** Where the service definition file lives for the current user. */
export function serviceFilePath(
  platform: ServicePlatform,
  root: string,
  home: string = os.homedir(),
): string {
  if (platform === "launchd") {
    return path.join(home, "Library", "LaunchAgents", `${launchdLabel(root)}.plist`);
  }
  if (platform === "schtasks") {
    // No per-user unit dir on Windows; we keep the task definition we registered
    // so `boot doctor` can detect (and uninstall can re-find) the managed task.
    return path.join(home, ".boot", "services", `${scheduledTaskName(root)}.xml`);
  }
  return path.join(home, ".config", "systemd", "user", `${systemdUnitName(root)}.service`);
}

/** Service files are UTF-8 except Windows Task Scheduler XML, which wants UTF-16. */
export function serviceFileEncoding(platform: ServicePlatform): "utf8" | "utf16le" {
  return platform === "schtasks" ? "utf16le" : "utf8";
}

export interface ServiceSpec {
  /** Absolute workspace root the service syncs. */
  root: string;
  /** Absolute path to the executable that launches boot (node, or the `boot` binary). */
  node: string;
  /**
   * Absolute path to the boot CLI entry script. Empty for a standalone compiled
   * binary, where `node` is the `boot` executable itself and takes no script arg.
   */
  entry: string;
  intervalSeconds: number;
  logFile: string;
  errFile: string;
  /** PATH made available to the service (git must be reachable). */
  pathEnv: string;
}

/**
 * The argv the service runs. For a source install that's
 * `node <entry> daemon start <root> --interval <n>`; for a standalone binary
 * `entry` is empty and `node` is the `boot` executable itself.
 */
export function programArguments(spec: ServiceSpec): string[] {
  const launcher = spec.entry ? [spec.node, spec.entry] : [spec.node];
  return [...launcher, "daemon", "start", spec.root, "--interval", String(spec.intervalSeconds)];
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shellQuote(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** Quote a Windows command-line argument when it contains whitespace. */
function winQuote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function renderLaunchdPlist(root: string, spec: ServiceSpec): string {
  const args = programArguments(spec)
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchdLabel(root)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.root)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.errFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(spec.pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit(root: string, spec: ServiceSpec): string {
  const exec = programArguments(spec).map(shellQuote).join(" ");

  return `[Unit]
Description=boot workspace sync daemon (${spec.root})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${spec.root}
Environment=${systemdQuote(`PATH=${spec.pathEnv}`)}
Restart=always
RestartSec=10
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.errFile}

[Install]
WantedBy=default.target
`;
}

export function renderSchtasksXml(root: string, spec: ServiceSpec): string {
  const [command, ...rest] = programArguments(spec);
  const args = rest.map(winQuote).join(" ");

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>boot workspace sync daemon (${xmlEscape(spec.root)})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command ?? "")}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(spec.root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function renderService(platform: ServicePlatform, root: string, spec: ServiceSpec): string {
  if (platform === "launchd") return renderLaunchdPlist(root, spec);
  if (platform === "schtasks") return renderSchtasksXml(root, spec);
  return renderSystemdUnit(root, spec);
}

export interface ServiceCommand {
  argv: string[];
  /** When true, a non-zero exit is tolerated (e.g. "not loaded" on uninstall). */
  ignoreError?: boolean;
}

/** Commands to run after the service file is written, to load + enable it. */
export function installCommands(
  platform: ServicePlatform,
  root: string,
  filePath: string,
  uid: number,
): ServiceCommand[] {
  if (platform === "launchd") {
    const label = launchdLabel(root);
    const domain = `gui/${uid}`;
    return [
      // Boot out any stale instance first so install is idempotent.
      { argv: ["launchctl", "bootout", `${domain}/${label}`], ignoreError: true },
      { argv: ["launchctl", "bootstrap", domain, filePath] },
      { argv: ["launchctl", "enable", `${domain}/${label}`], ignoreError: true },
    ];
  }
  if (platform === "schtasks") {
    const task = scheduledTaskName(root);
    // /F overwrites any existing task, so re-running install is idempotent;
    // /Run kicks it off now instead of waiting for the next logon.
    return [
      { argv: ["schtasks", "/Create", "/TN", task, "/XML", filePath, "/F"] },
      { argv: ["schtasks", "/Run", "/TN", task], ignoreError: true },
    ];
  }
  const unit = `${systemdUnitName(root)}.service`;
  return [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "enable", "--now", unit] },
  ];
}

/** Commands to run before the service file is deleted, to stop + disable it. */
export function uninstallCommands(
  platform: ServicePlatform,
  root: string,
  uid: number,
): ServiceCommand[] {
  if (platform === "launchd") {
    const label = launchdLabel(root);
    return [{ argv: ["launchctl", "bootout", `gui/${uid}/${label}`], ignoreError: true }];
  }
  if (platform === "schtasks") {
    const task = scheduledTaskName(root);
    return [
      { argv: ["schtasks", "/End", "/TN", task], ignoreError: true },
      { argv: ["schtasks", "/Delete", "/TN", task, "/F"], ignoreError: true },
    ];
  }
  const unit = `${systemdUnitName(root)}.service`;
  return [{ argv: ["systemctl", "--user", "disable", "--now", unit], ignoreError: true }];
}

/** A command to refresh the manager after a file change, or null when not needed. */
export function reloadCommand(platform: ServicePlatform): ServiceCommand | null {
  return platform === "systemd"
    ? { argv: ["systemctl", "--user", "daemon-reload"], ignoreError: true }
    : null;
}
