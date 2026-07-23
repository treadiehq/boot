import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadConfig, type ResolvedConfig } from "./config";
import { parseDotenv } from "./env";
import { isLinked, mapPaths } from "./map";
import { scanWorkspace } from "./scanner";
import {
  WORKSPACE_SCHEMA_VERSION,
  workspaceDefinitionSchema,
  type CommandDefinition,
  type ServiceDefinition,
  type WorkspaceDefinition,
} from "./workspace";
import { readPublishedWorkspace } from "./workspaceStore";

const packageJsonSchema = z
  .object({
    packageManager: z.string().optional(),
    engines: z.object({ node: z.string().optional() }).passthrough().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const composeSchema = z
  .object({
    services: z
      .record(
        z.string(),
        z
          .object({
            image: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", "env.example"] as const;
const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

export interface WorkspaceDiscovery {
  definition: WorkspaceDefinition;
  config: ResolvedConfig;
  repositories: number;
  environmentRequirements: number;
  services: number;
  tools: number;
}

export function toIdentifier(value: string, fallback = "workspace"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return normalized || fallback;
}

function uniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

async function readPackageJson(repoPath: string): Promise<z.infer<typeof packageJsonSchema> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(repoPath, "package.json"), "utf8"));
    const result = packageJsonSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function discoverEnvironmentNames(directory: string): Promise<string[]> {
  const names = new Set<string>();
  for (const fileName of ENV_EXAMPLE_FILES) {
    try {
      const parsed = parseDotenv(await fs.readFile(path.join(directory, fileName), "utf8"));
      for (const name of Object.keys(parsed)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
      }
    } catch {
      // An example file is optional and discovery is best-effort.
    }
  }
  return [...names];
}

function serviceFromImage(image: string | undefined): ServiceDefinition | null {
  if (!image) return null;
  const withoutDigest = image.split("@")[0]!;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const imageName = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const version = hasTag ? withoutDigest.slice(lastColon + 1) : undefined;
  const type = imageName?.split("/").pop();
  if (!type) return null;
  return {
    type: toIdentifier(type, "service"),
    ...(version ? { version } : {}),
  };
}

async function discoverServices(directory: string): Promise<Record<string, ServiceDefinition>> {
  const services: Record<string, ServiceDefinition> = {};
  const usedIds = new Set<string>();
  for (const fileName of COMPOSE_FILES) {
    try {
      const parsed = composeSchema.safeParse(
        parseYaml(await fs.readFile(path.join(directory, fileName), "utf8")),
      );
      if (!parsed.success) continue;
      for (const [name, service] of Object.entries(parsed.data.services ?? {})) {
        const discovered = serviceFromImage(service.image);
        if (discovered) {
          const id = uniqueIdentifier(toIdentifier(name, "service"), usedIds);
          services[id] = discovered;
        }
      }
    } catch {
      // Compose files are optional and malformed files are left to their own tooling.
    }
  }
  return services;
}

function addDiscoveredServices(
  services: Record<string, ServiceDefinition>,
  discovered: Record<string, ServiceDefinition>,
  usedIds: Set<string>,
  scope?: string,
  alwaysScope = false,
): void {
  for (const [name, definition] of Object.entries(discovered)) {
    const base = scope && (alwaysScope || usedIds.has(name)) ? `${scope}-${name}` : name;
    services[uniqueIdentifier(base, usedIds)] = definition;
  }
}

/**
 * Discover a conservative Workspace definition. Boot records evidence it can
 * prove and leaves roles, constraints, and unsupported requirements for review.
 */
export async function discoverWorkspace(workspacePath: string): Promise<WorkspaceDiscovery> {
  const root = path.resolve(workspacePath);
  const scan = await scanWorkspace(root);
  const usedIds = new Set<string>();
  const repositories: WorkspaceDefinition["repositories"] = {};
  const tools: Record<string, string> = {};
  const services: Record<string, ServiceDefinition> = {};
  const usedServiceIds = new Set<string>();
  const commands: Record<string, CommandDefinition> = {};
  const envNames = new Set(await discoverEnvironmentNames(root));

  addDiscoveredServices(
    services,
    await discoverServices(root),
    usedServiceIds,
  );

  for (const repo of scan.repos) {
    const id = uniqueIdentifier(toIdentifier(repo.name, "repository"), usedIds);
    repositories[id] = {
      path: repo.relativePath,
      ...(repo.remoteUrl ? { url: repo.remoteUrl } : {}),
      hydrate: scan.config.sourcePath ? scan.config.hydrateStrategy : "manual",
    };

    const packageJson = await readPackageJson(repo.absolutePath);
    if (packageJson?.packageManager) {
      const separator = packageJson.packageManager.lastIndexOf("@");
      if (separator > 0) {
        tools[packageJson.packageManager.slice(0, separator)] =
          packageJson.packageManager.slice(separator + 1);
      }
    }
    if (packageJson?.engines?.node) tools.node = packageJson.engines.node;

    if (packageJson) {
      const packageManager = repo.packageManager ?? "npm";
      const commandPrefix = scan.repos.length === 1 ? "" : `${id}-`;
      commands[`${commandPrefix}setup`] = { run: `${packageManager} install`, repository: id };
      for (const script of ["dev", "test"] as const) {
        if (packageJson.scripts?.[script]) {
          commands[`${commandPrefix}${script}`] = {
            run: `${packageManager} ${script}`,
            repository: id,
          };
        }
      }
    }

    for (const name of await discoverEnvironmentNames(repo.absolutePath)) envNames.add(name);
    addDiscoveredServices(
      services,
      await discoverServices(repo.absolutePath),
      usedServiceIds,
      id,
      scan.repos.length > 1,
    );
  }

  const workspaceName = scan.config.workspaceName ?? scan.rootName;
  const candidate = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspace: {
      id: toIdentifier(workspaceName),
      name: workspaceName,
    },
    repositories,
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    ...(Object.keys(services).length > 0 ? { services } : {}),
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
    ...(envNames.size > 0 ? { env: { required: [...envNames].sort() } } : {}),
    profiles: {
      local: {
        repositories: "all" as const,
        hydrate: "manual" as const,
      },
      agent: {
        repositories: "all" as const,
        hydrate: "eager" as const,
      },
    },
    defaults: { profile: "local" },
  };
  const definition = workspaceDefinitionSchema.parse(candidate);

  return {
    definition,
    config: scan.config,
    repositories: Object.keys(repositories).length,
    environmentRequirements: envNames.size,
    services: Object.keys(services).length,
    tools: Object.keys(tools).length,
  };
}

/** Load the canonical definition, or synthesize one for legacy Workspaces. */
export async function loadWorkspaceDefinition(workspacePath: string): Promise<WorkspaceDefinition> {
  const config = await loadConfig(workspacePath);
  if (config.definition) return config.definition;
  if (isLinked(workspacePath)) {
    const published = await readPublishedWorkspace(mapPaths(workspacePath).mapDir);
    if (published) return published;
  }
  return (await discoverWorkspace(workspacePath)).definition;
}
