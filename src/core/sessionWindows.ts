import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { execa } from "execa";
import { stateDir } from "./identity";
import { withFileLock } from "./lock";
import { WINDOWS_SESSION_SOURCE } from "./sessionWindowsSource";

const system = (...parts: string[]) => path.join(process.env.SystemRoot ?? "C:\\Windows", ...parts);
let sid: string | undefined;
export function windowsUserSid(): string {
  if (process.platform !== "win32") throw new Error("Windows identity requested on another platform.");
  sid ??= execFileSync(system("System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("Windows session owner SID is unavailable.");
  return sid;
}

// Used before any cached helper can execute. Only new Boot-owned directories
// receive a new DACL; existing directories are checked without changing access.
const DIRECTORY_POLICY = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $directory = [Environment]::GetEnvironmentVariable('BOOT_WINDOWS_DIRECTORY')
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ([Environment]::GetEnvironmentVariable('BOOT_WINDOWS_NEW_DIRECTORY') -eq '1') {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $principal = New-Object System.Security.Principal.SecurityIdentifier($id)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [System.IO.Directory]::SetAccessControl($directory, $acl)
  }
  $acl = [System.IO.Directory]::GetAccessControl($directory)
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { exit 1 }
  $writeMask = 2 -bor 4 -bor 16 -bor 256 -bor 64 -bor 65536 -bor 262144 -bor 524288
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and ([int]$rule.FileSystemRights -band $writeMask) -ne 0 -and $rule.IdentityReference.Value -notin @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) { exit 1 }
  }
  exit 0
} catch { exit 1 }
`;
async function directoryPolicy(directory: string, fresh: boolean): Promise<void> {
  const result = await execa(system("System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(DIRECTORY_POLICY, "utf16le").toString("base64")], {
    env: { BOOT_WINDOWS_DIRECTORY: directory, BOOT_WINDOWS_NEW_DIRECTORY: fresh ? "1" : "0" }, reject: false, windowsHide: true,
  });
  if (result.exitCode !== 0) throw new Error("Windows session directory must be owned by the current user and writable only by that user, SYSTEM, or Administrators.");
}
const helpers = new Map<string, Promise<string>>();
export async function windowsHelperPath(): Promise<string> {
  const home = stateDir();
  if (!helpers.has(home)) helpers.set(home, (async () => {
    const directory = path.join(home, "native-windows");
    const created = await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || await fs.realpath(directory) !== path.resolve(directory)) throw new Error("Windows helper cache must be a physical directory.");
    await directoryPolicy(directory, created !== undefined);
    const digest = createHash("sha256").update(WINDOWS_SESSION_SOURCE).digest("hex");
    const target = path.join(directory, `session-${digest}.exe`);
    return withFileLock(`${target}.lock`, "preparing the Windows session helper", async () => {
      const existing = await fs.lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (existing) { if (!existing.isFile()) throw new Error("Windows session helper must be a regular file."); return target; }
      const temporary = `${target}.${randomUUID()}`;
      try {
        await fs.writeFile(`${temporary}.cs`, WINDOWS_SESSION_SOURCE, { flag: "wx" });
        const compiler = system("Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
        const result = await execa(compiler, ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${temporary}.exe`, `${temporary}.cs`], { reject: false, windowsHide: true });
        if (result.exitCode !== 0) throw new Error("Could not compile the Windows session helper. Windows x64 with .NET Framework 4.8 is required.");
        await fs.rename(`${temporary}.exe`, target);
      } finally { await fs.rm(`${temporary}.cs`, { force: true }); await fs.rm(`${temporary}.exe`, { force: true }); }
      return target;
    }, { staleAfterMs: 1000, timeoutMs: 60_000 });
  })().catch((error) => { helpers.delete(home); throw error; }));
  return helpers.get(home)!;
}
export async function protectWindowsStore(directory: string, fresh: boolean): Promise<void> {
  if (fresh) await directoryPolicy(directory, true);
  const result = await execa(await windowsHelperPath(), ["verify-directory", directory], { reject: false, windowsHide: true });
  if (result.exitCode !== 0) throw new Error("Windows session store ownership or access permissions are unsafe.");
}
export async function windowsCloneFiles(files: Array<{ source: string; destination: string }>): Promise<void> {
  if (!files.length) return;
  let result;
  try { result = await execa(await windowsHelperPath(), ["clone"], { input: files.map(({ source, destination }) => `${source}\0${destination}\0`).join(""), reject: false, windowsHide: true }); }
  catch { throw Object.assign(new Error("Windows CoW requires the Windows session helper and a local ReFS volume."), { code: "EWINCLONE" }); }
  if (result.exitCode !== 0) {
    const nativeCode = result.stderr.match(/Windows session helper failed \((\d+)\)/)?.[1];
    throw Object.assign(new Error(`Native ReFS block cloning failed${nativeCode ? ` (Windows error ${nativeCode})` : ""}; files must support cloning on the same local ReFS volume, without named streams. No full-copy fallback was used.`), { code: "EWINCLONE" });
  }
}

export function sessionEnvironment(...layers: Array<NodeJS.ProcessEnv | Record<string, string>>): NodeJS.ProcessEnv {
  if (process.platform !== "win32") return Object.assign({}, ...layers);
  const result: NodeJS.ProcessEnv = {}, keys = new Map<string, string>();
  for (const layer of layers) for (const [key, value] of Object.entries(layer)) {
    const previous = keys.get(key.toUpperCase()); if (previous) delete result[previous];
    result[key] = value; keys.set(key.toUpperCase(), key);
  }
  return result;
}

/** Recognize Node package-manager shims without evaluating their batch syntax. */
export function nodeShimTarget(contents: string): string | null {
  const targets = new Set<string>();
  const pattern = /(?:"%_prog%"|node(?:\.exe)?|"%~dp0[\\/]node\.exe")\s+"%(?:dp0%|~dp0)[\\/]([^"\r\n%]+)"\s+%\*/gi;
  for (const match of contents.matchAll(pattern)) targets.add(match[1]!);
  return targets.size === 1 && /(?:_prog=node|\bnode(?:\.exe)?\s+"%~dp0)/i.test(contents) ? [...targets][0]! : null;
}
export async function windowsCommand(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const entries = (Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "").split(";").map((entry) => entry.replace(/^"|"$/g, "")).filter(Boolean);
  const find = async (name: string, extensions: string[]): Promise<string | null> => {
    const candidates = /[\\/:]/.test(name) ? [path.resolve(cwd, name)] : entries.map((entry) => path.resolve(cwd, entry, name));
    for (const candidate of candidates) for (const suffix of path.extname(candidate) ? [""] : extensions) {
      const target = candidate + suffix;
      if (await fs.stat(target).then((stat) => stat.isFile(), () => false)) return target;
    }
    return null;
  };
  const target = await find(argv[0]!, [".exe", ".com", ".cmd"]);
  if (!target) throw new Error("Windows executable was not found on PATH. Use an executable path or node plus a script path.");
  if (/\.(exe|com)$/i.test(target)) return [target, ...argv.slice(1)];
  if (/\.cmd$/i.test(target)) {
    const entry = nodeShimTarget(await fs.readFile(target, "utf8"));
    if (entry) {
      const node = await find(path.join(path.dirname(target), "node.exe"), [""]) ?? await find("node", [".exe"]);
      const script = path.resolve(path.dirname(target), entry);
      if (node && await fs.stat(script).then((stat) => stat.isFile(), () => false)) return [node, script, ...argv.slice(1)];
    }
  }
  throw new Error("This Windows batch wrapper is unsupported. Use the executable or node plus its entry script; Boot does not interpret arbitrary batch commands.");
}

export interface WindowsLaunch {
  child: ChildProcess; completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  completed: () => boolean; start: () => void; signal: (signal: NodeJS.Signals) => void; dispose: () => void;
}
export async function launchWindowsSession(helper: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, stdio: "inherit" | "ignore"): Promise<WindowsLaunch> {
  const pipeName = `boot-session-${randomUUID()}`;
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(`\\\\.\\pipe\\${pipeName}`, resolve); });
  let socket: net.Socket | undefined, requested: NodeJS.Signals | null = null, started = false, completed = false;
  let ready!: () => void, rejectReady!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  server.on("connection", (connection) => {
    if (socket) { connection.destroy(); return; } socket = connection;
    connection.setEncoding("utf8"); let input = "";
    connection.on("error", () => rejectReady(new Error("Windows session control channel failed.")));
    connection.on("data", (data) => {
      input += data;
      let newline: number;
      while ((newline = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, newline).trim(); input = input.slice(newline + 1);
        if (line === "ready") ready();
        else if (/^done \d+$/.test(line)) { completed = true; connection.write("ack\n"); }
      }
      if (input.length > 64) connection.destroy();
    });
  });
  const child = spawn(helper, ["run", String(process.pid), pipeName, ...argv], { cwd, env, stdio, windowsHide: false });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", () => { rejectReady(new Error("Could not start the Windows session helper.")); resolve({ code: 127, signal: null }); });
    child.once("exit", (code, signal) => { rejectReady(new Error("Windows session helper exited before startup.")); resolve({ code: requested ? null : code, signal: requested ?? signal }); });
  });
  const dispose = () => { socket?.destroy(); server.close(); };
  const timer = setTimeout(() => rejectReady(new Error("Windows session helper did not connect within 15 seconds.")), 15_000);
  try { await readiness; } catch (error) { child.kill(); dispose(); await completion; throw error; } finally { clearTimeout(timer); }
  return { child, completion, dispose, completed: () => completed,
    start: () => { started = true; socket!.write("start\n"); if (requested) socket!.write(`${requested}\n`); },
    signal: (signal) => { requested ??= signal; if (started) socket!.write(`${signal}\n`); },
  };
}
