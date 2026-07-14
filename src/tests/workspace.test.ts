import { describe, expect, it } from "vitest";
import {
  resolveWorkspace,
  workspaceDefinitionSchema,
  type WorkspaceDefinition,
} from "../core/workspace";

function definition(): WorkspaceDefinition {
  return workspaceDefinitionSchema.parse({
    schemaVersion: 1,
    workspace: { id: "treadie/undo", name: "undo" },
    repositories: {
      undo: {
        url: "https://github.com/treadiehq/undo.git",
        path: "undo",
        role: "core CLI",
      },
      benchmarks: {
        url: "https://github.com/treadiehq/benchmarks.git",
        path: "benchmarks",
        role: "recovery benchmarks",
      },
    },
    tools: { node: "24", pnpm: "10" },
    services: { postgres: { type: "postgres", version: "17" } },
    commands: {
      test: { run: "pnpm test", repository: "undo" },
      benchmark: { run: "pnpm bench", repository: "benchmarks" },
    },
    env: { required: ["OPENAI_API_KEY", { name: "CI", secret: false }] },
    constraints: ["Do not modify benchmarks unless explicitly requested"],
    profiles: {
      local: { repositories: "all", hydrate: "manual" },
      agent: {
        repositories: ["undo"],
        services: ["postgres"],
        commands: ["test"],
        env: ["OPENAI_API_KEY"],
        hydrate: "eager",
      },
    },
    defaults: { profile: "local" },
  });
}

describe("Workspace definition", () => {
  it("resolves a scoped Profile without duplicating Workspace definitions", () => {
    const resolved = resolveWorkspace(definition(), "agent");
    expect(resolved.id).toBe("treadie/undo");
    expect(resolved.profile).toBe("agent");
    expect(resolved.repositories.map((repository) => repository.id)).toEqual(["undo"]);
    expect(resolved.repositories[0]?.hydrate).toBe("eager");
    expect(Object.keys(resolved.commands)).toEqual(["test"]);
    expect(resolved.env.map((requirement) => requirement.name)).toEqual(["OPENAI_API_KEY"]);
    expect(resolved.constraints).toHaveLength(1);
  });

  it("uses the default Profile when none is requested", () => {
    expect(resolveWorkspace(definition()).profile).toBe("local");
  });

  it("rejects unknown Profile references", () => {
    const candidate = {
      ...definition(),
      profiles: { agent: { repositories: ["missing"] } },
      defaults: undefined,
    };
    expect(workspaceDefinitionSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(["../outside", "/absolute", "C:/absolute", "apps\\api", "apps/../api"])(
    "rejects unsafe repository path %s",
    (repositoryPath) => {
      const candidate = {
        ...definition(),
        repositories: {
          undo: { path: repositoryPath },
        },
        profiles: undefined,
        defaults: undefined,
        commands: undefined,
      };
      expect(workspaceDefinitionSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it("rejects duplicate and nested repository topology", () => {
    const duplicate = {
      ...definition(),
      repositories: {
        first: { path: "apps/api" },
        second: { path: "apps/API" },
      },
      profiles: undefined,
      defaults: undefined,
      commands: undefined,
    };
    expect(workspaceDefinitionSchema.safeParse(duplicate).success).toBe(false);

    const nested = {
      ...duplicate,
      repositories: {
        parent: { path: "apps/api" },
        child: { path: "apps/api/fixtures" },
      },
    };
    expect(workspaceDefinitionSchema.safeParse(nested).success).toBe(false);
  });

  it("never includes secret values in the object model", () => {
    const serialized = JSON.stringify(resolveWorkspace(definition(), "agent"));
    expect(serialized).toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("secret123");
  });
});
