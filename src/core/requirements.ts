import { execa } from "execa";
import type {
  ResolvedEnvironmentRequirement,
  ServiceDefinition,
} from "./workspace";
import { sanitizeUserText } from "./userErrors";

export type RequirementState = "available" | "missing" | "mismatch" | "unsupported";

export interface RequirementStatus {
  name: string;
  required?: string;
  state: RequirementState;
  observed?: string;
  detail?: string;
}

interface CommandResult {
  ok: boolean;
  output: string;
  notFound: boolean;
}

async function runProbe(command: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execa(command, args, {
      reject: false,
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      ok: result.exitCode === 0,
      output: sanitizeUserText(result.stdout || result.stderr),
      notFound: result.code === "ENOENT",
    };
  } catch (error) {
    return {
      ok: false,
      output: "",
      notFound: (error as NodeJS.ErrnoException).code === "ENOENT",
    };
  }
}

function numericVersion(value: string): number[] | null {
  const match = value.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A deliberately small matcher for common runtime requirements. */
export function versionSatisfies(observed: string, requirement: string): boolean {
  const actual = numericVersion(observed);
  const required = numericVersion(requirement);
  if (!actual || !required) return observed.includes(requirement);

  const trimmed = requirement.trim();
  if (trimmed.startsWith(">=")) return compareVersion(actual, required) >= 0;
  if (trimmed.startsWith(">")) return compareVersion(actual, required) > 0;
  if (trimmed.startsWith("<=")) return compareVersion(actual, required) <= 0;
  if (trimmed.startsWith("<")) return compareVersion(actual, required) < 0;
  if (trimmed.startsWith("^")) return actual[0] === required[0] && compareVersion(actual, required) >= 0;
  if (trimmed.startsWith("~")) {
    return (
      actual[0] === required[0] &&
      actual[1] === required[1] &&
      compareVersion(actual, required) >= 0
    );
  }

  const requestedParts = trimmed.replace(/^v/, "").split(".").length;
  return actual.slice(0, requestedParts).every((part, index) => part === required[index]);
}

const TOOL_PROBES: Record<string, { command: string; args: string[] }> = {
  node: { command: "node", args: ["--version"] },
  pnpm: { command: "pnpm", args: ["--version"] },
  npm: { command: "npm", args: ["--version"] },
  yarn: { command: "yarn", args: ["--version"] },
  bun: { command: "bun", args: ["--version"] },
  python: { command: "python", args: ["--version"] },
  python3: { command: "python3", args: ["--version"] },
  go: { command: "go", args: ["version"] },
  rust: { command: "rustc", args: ["--version"] },
  git: { command: "git", args: ["--version"] },
};

export async function inspectTools(
  requirements: Record<string, string>,
): Promise<RequirementStatus[]> {
  const statuses: RequirementStatus[] = [];
  for (const [name, required] of Object.entries(requirements)) {
    const probe = TOOL_PROBES[name];
    if (!probe) {
      statuses.push({
        name,
        required,
        state: "unsupported",
        detail: `automatic checks are not available for "${name}"; verify it manually`,
      });
      continue;
    }
    const result = await runProbe(probe.command, probe.args);
    if (!result.ok) {
      statuses.push({
        name,
        required,
        state: "missing",
        detail: result.notFound
          ? `"${probe.command}" was not found on PATH; install it, then retry`
          : `"${probe.command}" could not report its version; run it directly for details`,
      });
      continue;
    }
    statuses.push({
      name,
      required,
      observed: result.output,
      state: versionSatisfies(result.output, required) ? "available" : "mismatch",
    });
  }
  return statuses;
}

async function inspectPostgres(name: string, required?: string): Promise<RequirementStatus> {
  const ready = await runProbe("pg_isready", []);
  if (!ready.ok) {
    return {
      name,
      required,
      state: "missing",
      detail: ready.notFound
        ? `"pg_isready" was not found on PATH; install PostgreSQL tools, then retry`
        : "PostgreSQL did not report ready; run `pg_isready` for details, fix the reported problem, then retry",
    };
  }
  const version = await runProbe("psql", ["--version"]);
  const state =
    required && version.ok && !versionSatisfies(version.output, required)
      ? "mismatch"
      : "available";
  return {
    name,
    required,
    state,
    observed: version.output || ready.output,
  };
}

async function inspectRedis(name: string, required?: string): Promise<RequirementStatus> {
  const ready = await runProbe("redis-cli", ["ping"]);
  if (!ready.ok || ready.output.toUpperCase() !== "PONG") {
    return {
      name,
      required,
      state: "missing",
      detail: ready.notFound
        ? `"redis-cli" was not found on PATH; install Redis tools, then retry`
        : "Redis did not return PONG; run `redis-cli ping` for details, fix the reported problem, then retry",
    };
  }
  const version = await runProbe("redis-server", ["--version"]);
  const state =
    required && version.ok && !versionSatisfies(version.output, required)
      ? "mismatch"
      : "available";
  return { name, required, state, observed: version.output || "PONG" };
}

async function inspectDocker(name: string, required?: string): Promise<RequirementStatus> {
  const result = await runProbe("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (!result.ok) {
    return {
      name,
      required,
      state: "missing",
      detail: result.notFound
        ? `"docker" was not found on PATH; install Docker, then retry`
        : "Docker did not report server information; run `docker info` for details, fix the reported problem, then retry",
    };
  }
  return {
    name,
    required,
    observed: result.output,
    state: required && !versionSatisfies(result.output, required) ? "mismatch" : "available",
  };
}

export async function inspectServices(
  requirements: Record<string, ServiceDefinition>,
): Promise<RequirementStatus[]> {
  const statuses: RequirementStatus[] = [];
  for (const [name, definition] of Object.entries(requirements)) {
    const type = definition.type ?? name;
    if (type === "postgres" || type === "postgresql") {
      statuses.push(await inspectPostgres(name, definition.version));
    } else if (type === "redis") {
      statuses.push(await inspectRedis(name, definition.version));
    } else if (type === "docker") {
      statuses.push(await inspectDocker(name, definition.version));
    } else {
      statuses.push({
        name,
        required: definition.version,
        state: "unsupported",
        detail: `automatic checks are not available for service type "${type}"; verify it manually`,
      });
    }
  }
  return statuses;
}

export interface EnvironmentStatus {
  name: string;
  secret: boolean;
  source?: string;
  available: boolean;
  availableFrom?: "process" | "boot";
}

export function inspectProcessEnvironment(
  requirements: ResolvedEnvironmentRequirement[],
  bootNames: Set<string> = new Set(),
): EnvironmentStatus[] {
  return requirements.map((requirement) => {
    const fromProcess = process.env[requirement.name] !== undefined;
    const fromBoot = bootNames.has(requirement.name);
    const source = requirement.source?.toLowerCase();
    const available =
      source === "process" ? fromProcess : source === "boot" ? fromBoot : fromProcess || fromBoot;
    const availableFrom =
      available && fromProcess
        ? ("process" as const)
        : available && fromBoot
          ? ("boot" as const)
          : undefined;
    return {
      name: requirement.name,
      secret: requirement.secret,
      source: requirement.source,
      available,
      ...(availableFrom ? { availableFrom } : {}),
    };
  });
}
