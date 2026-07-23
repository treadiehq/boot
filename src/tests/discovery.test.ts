import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverWorkspace, loadWorkspaceDefinition } from "../core/discovery";
import { CONFIG_FILE_NAME } from "../core/config";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-discovery-"));
  const repository = path.join(root, "apps", "api");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(repository, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.2.0",
      engines: { node: ">=24" },
      scripts: { dev: "node server.js", test: "vitest run" },
    }),
  );
  await fs.writeFile(path.join(repository, ".env.example"), "OPENAI_API_KEY=\nPORT=3000\n");
  await fs.writeFile(
    path.join(root, "compose.yaml"),
    "services:\n  database:\n    image: postgres:17\n",
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("discoverWorkspace", () => {
  it("discovers repositories, tools, services, commands, and environment names", async () => {
    const discovery = await discoverWorkspace(root);
    expect(discovery.repositories).toBe(1);
    expect(discovery.tools).toBe(2);
    expect(discovery.services).toBe(1);
    expect(discovery.environmentRequirements).toBe(2);
    expect(discovery.definition.repositories.api).toMatchObject({
      path: "apps/api",
      hydrate: "manual",
    });
    expect(discovery.definition.tools).toEqual({ pnpm: "10.2.0", node: ">=24" });
    expect(discovery.definition.services?.database).toEqual({
      type: "postgres",
      version: "17",
    });
    expect(discovery.definition.commands).toMatchObject({
      setup: { run: "pnpm install", repository: "api" },
      dev: { run: "pnpm dev", repository: "api" },
      test: { run: "pnpm test", repository: "api" },
    });
  });

  it("preserves same-named services from multiple repositories", async () => {
    const api = path.join(root, "apps", "api");
    await fs.writeFile(
      path.join(api, "compose.yaml"),
      "services:\n  database:\n    image: postgres:16\n",
    );
    const web = path.join(root, "apps", "web");
    await fs.mkdir(path.join(web, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(web, "compose.yaml"),
      "services:\n  database:\n    image: redis:7\n",
    );

    const discovery = await discoverWorkspace(root);

    expect(discovery.services).toBe(3);
    expect(discovery.definition.services).toEqual({
      database: { type: "postgres", version: "17" },
      "api-database": { type: "postgres", version: "16" },
      "web-database": { type: "redis", version: "7" },
    });
  });

  it("preserves root and repository services with the same name", async () => {
    await fs.writeFile(
      path.join(root, "apps", "api", "compose.yaml"),
      "services:\n  database:\n    image: redis:7\n",
    );

    const discovery = await discoverWorkspace(root);

    expect(discovery.services).toBe(2);
    expect(discovery.definition.services).toEqual({
      database: { type: "postgres", version: "17" },
      "api-database": { type: "redis", version: "7" },
    });
  });

  it("distinguishes registry ports from image tags", async () => {
    await fs.writeFile(
      path.join(root, "compose.yaml"),
      [
        "services:",
        "  database:",
        "    image: localhost:5000/postgres:17",
        "  cache:",
        "    image: localhost:5000/redis",
        "  application:",
        "    image: registry.example.com:8443/team/app:v1",
        "",
      ].join("\n"),
    );

    const discovery = await discoverWorkspace(root);

    expect(discovery.definition.services).toEqual({
      database: { type: "postgres", version: "17" },
      cache: { type: "redis" },
      application: { type: "app", version: "v1" },
    });
  });

  it("adapts a legacy boot.yaml into the versioned Workspace model", async () => {
    await fs.writeFile(path.join(root, CONFIG_FILE_NAME), "workspace:\n  name: Legacy Code\n");
    const definition = await loadWorkspaceDefinition(root);
    expect(definition).toMatchObject({
      schemaVersion: 1,
      workspace: { id: "legacy-code", name: "Legacy Code" },
    });
    expect(definition.repositories.api?.path).toBe("apps/api");
  });
});
