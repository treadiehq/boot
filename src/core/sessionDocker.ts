import { execa } from "execa";

/** Accept only local transports. In particular, a Windows pipe must name this
 * machine, never an SMB server or a TCP endpoint (even a loopback endpoint). */
export function validateLocalDockerEndpoint(endpoint: string, platform = process.platform): void {
  const local = platform === "win32"
    ? /^npipe:\/\/\/\/\.\/pipe\/[a-z0-9][a-z0-9_.-]*$/i.test(endpoint)
    : /^unix:\/\/\/[^\r\n\0]+$/.test(endpoint);
  if (!local || /[\r\n\0]/.test(endpoint)) {
    throw new Error(platform === "win32"
      ? "Session runtimes require a local Docker named pipe. Select Docker Desktop's Linux engine; remote and TCP endpoints are unsupported."
      : "Session runtimes require a local Docker Unix socket; remote Docker endpoints are unsupported.");
  }
}

/** Docker output is consumed privately; raw errors/config/environment never
 * enter diagnostics. Arguments never contain database passwords. */
export async function docker(args: string[], env?: Record<string, string>, timeout = 30_000) {
  try { return await execa("docker", args, { env, reject: false, timeout }); }
  catch { throw new Error("Docker could not complete a session runtime operation. Check the local Docker daemon and retry."); }
}

export async function mustDocker(args: string[], env?: Record<string, string>, timeout?: number) {
  const result = await docker(args, env, timeout);
  if (result.exitCode !== 0) throw new Error(`Docker session operation ${args.slice(0, 2).join(" ")} failed; owned resources remain journaled for recovery.`);
  return result.stdout;
}

export async function daemonIdentity(): Promise<string> {
  // Docker's explicit context takes precedence over DOCKER_HOST. Pass its name
  // to context inspect as well, so validation examines the engine we will use.
  const context = process.env.DOCKER_CONTEXT;
  const endpoint = !context && process.env.DOCKER_HOST ? process.env.DOCKER_HOST
    : (await mustDocker(["context", "inspect", ...(context ? [context] : []), "--format", "{{.Endpoints.docker.Host}}"])).trim();
  validateLocalDockerEndpoint(endpoint);
  const [os, id] = (await mustDocker(["info", "--format", "{{.OSType}}|{{.ID}}"])).trim().split("|");
  if (os !== "linux") throw new Error("Managed PostgreSQL requires a Linux Docker engine. On Windows, switch Docker Desktop to Linux containers and retry.");
  const version = (await mustDocker(["version", "--format", "{{.Server.Version}}"])).trim();
  if (Number(version.split(".")[0]) < 28 || !/^\d+\./.test(version)) throw new Error("Session runtimes require Docker Engine 28 or newer for loopback-only publishing.");
  if (!id) throw new Error("Docker daemon identity is unavailable.");
  return id;
}
