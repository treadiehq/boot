import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// CI-only transport bridge to a real Docker engine in this machine's disposable
// WSL2 distro. Forward raw bytes; never inspect/log Docker requests or passwords.
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") throw new Error("This bridge is only for the Windows CI fixture.");
const distro = process.argv[2];
if (!/^BootPostgres-[a-f0-9]{32}$/.test(distro ?? "")) throw new Error("An owned WSL fixture is required.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const name = `boot-postgres-${randomUUID()}`;
const processes = new Set();
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  const proxy = spawn("wsl.exe", ["--distribution", distro, "--user", "root", "--exec", "socat", "STDIO", "UNIX-CONNECT:/var/run/docker.sock"], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  processes.add(proxy);
  socket.pipe(proxy.stdin); proxy.stdout.pipe(socket);
  proxy.once("error", () => socket.destroy());
  proxy.stdin.on("error", () => socket.destroy());
  socket.on("error", () => proxy.kill());
  socket.once("close", () => { sockets.delete(socket); proxy.kill(); });
  proxy.once("exit", () => { processes.delete(proxy); socket.end(); });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(`\\\\.\\pipe\\${name}`, resolve); });

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", () => reject(new Error("Could not run a Windows Docker test command.")));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
let contextCreated = false;
// A systemd Docker service alone does not keep a WSL distribution running.
// Keep an owned foreground process alive throughout the host-side suite.
const keeper = spawn("wsl.exe", ["--distribution", distro, "--user", "root", "--exec", "sleep", "infinity"], { stdio: "ignore", windowsHide: true });
keeper.on("error", () => {});
try {
  if (await run("docker", ["context", "create", name, "--docker", `host=npipe:////./pipe/${name}`]) !== 0) throw new Error("Could not create the fixture Docker context.");
  contextCreated = true;
  // Prove the explicit context overrides a conflicting host without changing
  // the machine's selected/default Docker context or its Windows engine.
  const env = { ...process.env, DOCKER_CONTEXT: name, DOCKER_HOST: "tcp://127.0.0.1:1" };
  // No resources/passwords exist yet: expose only transport errors and the
  // engine OS here, so a broken fixture cannot mask the integration results.
  if (await run("docker", ["info", "--format", "Engine through Windows pipe: {{.OSType}}"], env) !== 0) throw new Error("The Windows named-pipe fixture could not reach its Linux engine.");
  process.exitCode = await run(process.execPath, ["scripts/distribution/session-runtime.mjs"], env);
} finally {
  if (contextCreated && await run("docker", ["context", "rm", "--force", name]) !== 0) process.exitCode = 1;
  for (const socket of sockets) socket.destroy();
  for (const child of processes) child.kill();
  keeper.kill();
  await new Promise((resolve) => server.close(resolve));
}
