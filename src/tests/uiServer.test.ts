import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { recordWorkspace } from "../core/registry";
import {
  startUiServer,
  validateUiPort,
  type RunningUiServer,
} from "../core/uiServer";

let home: string;
let workspace: string;
let dist: string;
let previousBootHome: string | undefined;
let running: RunningUiServer | null = null;

const BOOT_YAML = JSON.stringify({
  schemaVersion: 1,
  workspace: { id: "demo/ui", name: "UI Demo", description: "launchpad test workspace" },
  repositories: {},
  services: {
    fakedb: {
      check: `node -e "process.exit(require('fs').existsSync('svc-ready.txt') ? 0 : 1)"`,
      start: `node -e "require('fs').writeFileSync('svc-ready.txt', 'ok')"`,
    },
  },
  profiles: { local: {}, agent: {} },
  defaults: { profile: "local" },
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "boot-ui-"));
  previousBootHome = process.env.BOOT_HOME;
  process.env.BOOT_HOME = path.join(home, "boot-home");
  workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "boot.yaml"), BOOT_YAML, "utf8");
  dist = path.join(home, "dist");
  await fs.mkdir(dist, { recursive: true });
  await fs.writeFile(path.join(dist, "index.html"), "<html>launchpad</html>", "utf8");
  await recordWorkspace(workspace, "UI Demo");
  running = await startUiServer({ port: 0, distDir: dist });
});

afterEach(async () => {
  await running?.close();
  running = null;
  if (previousBootHome === undefined) delete process.env.BOOT_HOME;
  else process.env.BOOT_HOME = previousBootHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("boot ui server", () => {
  it("strictly validates CLI and programmatic port values", async () => {
    expect(validateUiPort("0")).toBe(0);
    expect(() => validateUiPort("8O88")).toThrow(
      "UI port must be a whole number from 0 to 65535.",
    );
    await expect(
      startUiServer({ port: Number.NaN, distDir: dist }),
    ).rejects.toThrow("UI port must be a whole number from 0 to 65535.");
  });

  it("lists registered workspaces with their profiles", async () => {
    const response = await fetch(`${running!.url}/api/workspaces`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspaces: Array<Record<string, unknown>> };
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({
      root: workspace,
      name: "UI Demo",
      profiles: ["local", "agent"],
      defaultProfile: "local",
      exists: true,
    });
  });

  it("returns secret-free diagnostics for a registered workspace", async () => {
    const response = await fetch(
      `${running!.url}/api/inspect?root=${encodeURIComponent(workspace)}&profile=local`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.workspace).toMatchObject({ id: "demo/ui", profile: "local", ready: false });
    expect(body.services[0]).toMatchObject({ name: "fakedb", state: "missing" });
  });

  it("refuses to inspect an unregistered root", async () => {
    const response = await fetch(
      `${running!.url}/api/inspect?root=${encodeURIComponent(path.join(home, "elsewhere"))}`,
    );
    expect(response.status).toBe(403);
  });

  it("streams service startup events and a final result from /api/up", async () => {
    const response = await fetch(`${running!.url}/api/up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: workspace, start: true }),
    });
    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines[0]).toMatchObject({ type: "plan", ready: false });
    const phases = lines.filter((line) => line.type === "service").map((line) => line.phase);
    expect(phases).toEqual(["starting", "waiting", "ready"]);
    const result = lines.at(-1);
    expect(result).toMatchObject({ type: "result", ready: true });
    expect(result.applied).toContainEqual({ kind: "service", name: "fakedb" });
  });

  it("serves static assets with an index fallback", async () => {
    const index = await fetch(`${running!.url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("launchpad");

    const fallback = await fetch(`${running!.url}/some/spa/route`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("launchpad");

    const missing = await fetch(`${running!.url}/missing.js`);
    expect(missing.status).toBe(404);
  });

  it("rejects non-local Host headers", async () => {
    // fetch/undici does not allow overriding Host, so use a raw request.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: running!.port,
          path: "/api/workspaces",
          headers: { host: "evil.example.com" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });
});
