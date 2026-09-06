import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { daemonIdentity, validateLocalDockerEndpoint } from "../core/sessionDocker";

vi.mock("execa", () => ({ execa: vi.fn() }));
const exec = vi.mocked(execa);
const local = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
beforeEach(() => { vi.stubEnv("DOCKER_HOST", undefined); vi.stubEnv("DOCKER_CONTEXT", undefined); });
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("local Docker transports", () => {
  it.each(["npipe:////./pipe/docker_engine", "npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/boot-test-123"])("accepts local Windows pipe %s", (endpoint) => {
    expect(() => validateLocalDockerEndpoint(endpoint, "win32")).not.toThrow();
  });
  it.each(["npipe:////server/pipe/docker_engine", "npipe:////localhost/pipe/docker_engine", "npipe:////./pipe/../docker_engine", "npipe:////./pipe/docker_engine/extra", "npipe:////./pipe/docker_engine\n", "npipe:////./pipe/docker_engine?remote=1", "tcp://127.0.0.1:2375", "ssh://host", "unix:///var/run/docker.sock"])("rejects nonlocal or malformed Windows endpoint %s", (endpoint) => {
    expect(() => validateLocalDockerEndpoint(endpoint, "win32")).toThrow(/local Docker named pipe/);
  });
  it.each(["darwin", "linux"] as const)("keeps local Unix sockets on %s", (platform) => {
    expect(() => validateLocalDockerEndpoint("unix:///var/run/docker.sock", platform)).not.toThrow();
    for (const endpoint of ["unix://relative.sock", "tcp://127.0.0.1:2375", "ssh://host", "npipe:////./pipe/docker_engine"]) {
      expect(() => validateLocalDockerEndpoint(endpoint, platform)).toThrow(/local Docker Unix socket/);
    }
  });
});

describe("Docker runtime preflight", () => {
  function reply(stdout: string, exitCode = 0) {
    exec.mockResolvedValueOnce({ stdout, exitCode } as Awaited<ReturnType<typeof execa>>);
  }
  it("uses the selected context ahead of DOCKER_HOST and verifies a Linux engine", async () => {
    vi.stubEnv("DOCKER_CONTEXT", "desktop-linux"); vi.stubEnv("DOCKER_HOST", "tcp://remote.invalid:2375");
    reply(local); reply("linux|fixture-daemon\r\n"); reply("28.5.1");
    expect(await daemonIdentity()).toBe("fixture-daemon");
    expect(exec).toHaveBeenNthCalledWith(1, "docker", ["context", "inspect", "desktop-linux", "--format", "{{.Endpoints.docker.Host}}"], expect.any(Object));
  });
  it("uses an explicit local host when no context override is selected", async () => {
    vi.stubEnv("DOCKER_HOST", local); reply("linux|fixture-daemon"); reply("29.1.0");
    expect(await daemonIdentity()).toBe("fixture-daemon");
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("rejects a remote selected context before contacting its daemon", async () => {
    reply("tcp://remote.invalid:2375");
    await expect(daemonIdentity()).rejects.toThrow(/local Docker/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("rejects Windows container mode before provisioning", async () => {
    vi.stubEnv("DOCKER_HOST", local); reply("windows|fixture-daemon");
    await expect(daemonIdentity()).rejects.toThrow(/Linux containers/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each(["27.5.1", "unknown"])("rejects unsupported server version %s", async (version) => {
    vi.stubEnv("DOCKER_HOST", local); reply("linux|fixture-daemon"); reply(version);
    await expect(daemonIdentity()).rejects.toThrow(/28 or newer/);
  });
  it("requires a durable daemon identity", async () => {
    vi.stubEnv("DOCKER_HOST", local); reply("linux|"); reply("28.5.1");
    await expect(daemonIdentity()).rejects.toThrow(/identity is unavailable/);
  });
  it("does not surface Docker errors or configuration values", async () => {
    vi.stubEnv("DOCKER_HOST", local);
    exec.mockRejectedValueOnce(new Error("synthetic private endpoint"));
    await expect(daemonIdentity()).rejects.toThrow("Docker could not complete a session runtime operation. Check the local Docker daemon and retry.");
  });
});
