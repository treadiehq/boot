import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execaCommand } from "execa";
import {
  materializeSelected,
  storedEnvironmentNames,
} from "./env";
import {
  checkoutBranch,
  getCurrentBranch,
  getRemoteUrl,
  isDirty,
  isGitRepo,
} from "./git";
import { hydratePlaceholder } from "./hydrate";
import { isLinked, mapPaths, type SharedRepo } from "./map";
import {
  buildPlaceholderMeta,
  isPlaceholder,
  readPlaceholder,
  writePlaceholder,
} from "./placeholder";
import type {
  RealizationOptions,
  RealizationPlan,
  RealizationResult,
  RepositoryPlan,
  WorkspaceProvider,
} from "./provider";
import { reconcileFromMap } from "./reconcile";
import {
  inspectProcessEnvironment,
  inspectServices,
  inspectTools,
  type EnvironmentStatus,
} from "./requirements";
import { keyExists, loadKey } from "./secrets";
import { resolveWithinRoot } from "./pathUtils";
import {
  quoteUserValue,
  sanitizeRemoteUrl,
  sanitizeUserText,
} from "./userErrors";
import type { ResolvedRepository, ResolvedWorkspace } from "./workspace";

function normalizedRemote(remote: string): string {
  return remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

async function inspectRepository(
  root: string,
  repository: ResolvedRepository,
): Promise<RepositoryPlan> {
  const repositoryPath = resolveWithinRoot(root, repository.path);
  if (isGitRepo(repositoryPath)) {
    const [currentRef, dirty, currentRemote] = await Promise.all([
      getCurrentBranch(repositoryPath),
      isDirty(repositoryPath),
      getRemoteUrl(repositoryPath),
    ]);
    if (
      repository.url &&
      currentRemote &&
      normalizedRemote(repository.url) !== normalizedRemote(currentRemote)
    ) {
      return {
        id: repository.id,
        path: repository.path,
        role: repository.role,
        url: repository.url,
        ref: repository.ref,
        state: "conflict",
        action: "conflict",
        currentRef: currentRef ?? undefined,
        dirty,
        detail:
          `origin is ${quoteUserValue(sanitizeRemoteUrl(currentRemote), 500)}, ` +
          `but boot.yaml expects ${quoteUserValue(sanitizeRemoteUrl(repository.url), 500)}`,
      };
    }
    if (repository.ref && currentRef !== repository.ref) {
      return {
        id: repository.id,
        path: repository.path,
        role: repository.role,
        url: repository.url,
        ref: repository.ref,
        state: dirty ? "conflict" : "hydrated",
        action: dirty ? "conflict" : "checkout",
        currentRef: currentRef ?? undefined,
        dirty,
        detail: dirty
          ? `repository has uncommitted changes on ${
              currentRef ? quoteUserValue(currentRef) : "no branch"
            }; boot.yaml expects ${quoteUserValue(repository.ref)}`
          : undefined,
      };
    }
    return {
      id: repository.id,
      path: repository.path,
      role: repository.role,
      url: repository.url,
      ref: repository.ref,
      state: "hydrated",
      action: "none",
      currentRef: currentRef ?? undefined,
      dirty,
    };
  }

  if (isPlaceholder(repositoryPath)) {
    const metadata = await readPlaceholder(repositoryPath);
    const stale =
      metadata?.remoteUrl !== (repository.url ?? null) ||
      metadata?.branch !== (repository.ref ?? null);
    return {
      id: repository.id,
      path: repository.path,
      role: repository.role,
      url: repository.url,
      ref: repository.ref,
      state: "placeholder",
      action:
        repository.hydrate === "eager"
          ? "hydrate"
          : stale
            ? "update-placeholder"
            : "none",
      detail: !repository.url ? "no repository URL is available" : undefined,
    };
  }

  if (existsSync(repositoryPath)) {
    return {
      id: repository.id,
      path: repository.path,
      role: repository.role,
      url: repository.url,
      ref: repository.ref,
      state: "conflict",
      action: "conflict",
      detail: "path exists but is not a Git repository or a repository download folder",
    };
  }

  return {
    id: repository.id,
    path: repository.path,
    role: repository.role,
    url: repository.url,
    ref: repository.ref,
    state: "missing",
    action: repository.hydrate === "eager" && repository.url ? "clone" : "placeholder",
    detail: !repository.url ? "no repository URL is available" : undefined,
  };
}

async function bootEnvironmentNames(root: string): Promise<Set<string>> {
  if (!isLinked(root) || !keyExists()) return new Set();
  return storedEnvironmentNames(mapPaths(root).mapDir, await loadKey());
}

function planBlockers(
  repositories: RepositoryPlan[],
  tools: RealizationPlan["tools"],
  services: RealizationPlan["services"],
  environment: EnvironmentStatus[],
): string[] {
  const blockers: string[] = [];
  for (const repository of repositories) {
    if (repository.action !== "none") {
      const action =
        repository.action === "clone"
          ? "repository needs to be downloaded"
          : repository.action === "placeholder"
            ? "repository folder needs to be created"
            : repository.action === "hydrate"
              ? "repository has not been downloaded"
              : repository.action === "update-placeholder"
                ? "repository download information needs updating"
                : repository.action === "checkout"
                  ? `repository must switch to ${quoteUserValue(repository.ref ?? "the requested branch")}`
                  : "existing files conflict with boot.yaml";
      blockers.push(
        `repository ${quoteUserValue(repository.id)}: ${repository.detail ?? action}`,
      );
    } else if (repository.state === "placeholder" && !repository.url) {
      blockers.push(`repository ${quoteUserValue(repository.id)}: no repository URL is available`);
    }
  }
  for (const status of [...tools, ...services]) {
    if (status.state !== "available") {
      blockers.push(
        `${quoteUserValue(status.name)}: ${status.detail ?? sanitizeUserText(status.state)}`,
      );
    }
  }
  for (const status of environment) {
    if (!status.available) {
      blockers.push(
        `${quoteUserValue(status.name)}: required environment variable is not available`,
      );
    }
  }
  return blockers;
}

function sharedRepo(repository: ResolvedRepository): SharedRepo {
  return {
    name: repository.id,
    relativePath: repository.path,
    remoteUrl: repository.url ?? null,
    branch: repository.ref ?? null,
    lastCommit: null,
    packageManager: null,
    projectType: "unknown",
  };
}

async function updatePlaceholder(
  root: string,
  repository: ResolvedRepository,
): Promise<void> {
  const repositoryPath = resolveWithinRoot(root, repository.path);
  const existing = await readPlaceholder(repositoryPath);
  const metadata = buildPlaceholderMeta({
    name: repository.id,
    relativePath: repository.path,
    remoteUrl: repository.url ?? null,
    currentBranch: repository.ref ?? null,
    lastCommit: existing?.lastCommit ?? null,
  });
  await writePlaceholder(repositoryPath, {
    ...metadata,
    createdAt: existing?.createdAt ?? metadata.createdAt,
  });
}

export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly name = "local";

  async inspect(root: string, workspace: ResolvedWorkspace): Promise<RealizationPlan> {
    const absoluteRoot = path.resolve(root);
    const [repositories, tools, services, bootNames] = await Promise.all([
      Promise.all(
        workspace.repositories.map((repository) =>
          inspectRepository(absoluteRoot, repository),
        ),
      ),
      inspectTools(workspace.tools),
      inspectServices(workspace.services),
      bootEnvironmentNames(absoluteRoot),
    ]);
    const environment = inspectProcessEnvironment(workspace.env, bootNames);
    const blockers = planBlockers(repositories, tools, services, environment);
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        profile: workspace.profile,
      },
      provider: this.name,
      root: absoluteRoot,
      readOnly: workspace.readOnly,
      repositories,
      tools,
      services,
      environment,
      commands: workspace.commands,
      constraints: workspace.constraints,
      ready: blockers.length === 0,
      blockers,
    };
  }

  async plan(root: string, workspace: ResolvedWorkspace): Promise<RealizationPlan> {
    return this.inspect(root, workspace);
  }

  async apply(
    root: string,
    workspace: ResolvedWorkspace,
    plan: RealizationPlan,
    options: RealizationOptions = {},
  ): Promise<RealizationResult> {
    const absoluteRoot = path.resolve(root);
    await fs.mkdir(absoluteRoot, { recursive: true });
    const applied: RealizationResult["applied"] = [];
    const failures: RealizationResult["failures"] = [];
    const byId = new Map(workspace.repositories.map((repository) => [repository.id, repository]));

    for (const item of plan.repositories) {
      const repository = byId.get(item.id)!;
      const repositoryPath = resolveWithinRoot(absoluteRoot, repository.path);
      try {
        if (item.action === "clone" || item.action === "placeholder") {
          const result = await reconcileFromMap(absoluteRoot, [sharedRepo(repository)], {
            eager: item.action === "clone",
          });
          if (result.failures.length > 0) {
            failures.push({
              kind: "repository",
              name: repository.id,
              message: result.failures[0]!.message,
            });
          } else {
            applied.push({ kind: "repository", name: repository.id });
          }
        } else if (item.action === "update-placeholder") {
          await updatePlaceholder(absoluteRoot, repository);
          applied.push({ kind: "repository", name: repository.id });
        } else if (item.action === "hydrate") {
          await updatePlaceholder(absoluteRoot, repository);
          const outcome = await hydratePlaceholder(repositoryPath);
          if (outcome === "hydrated-checkout-failed") {
            throw new Error(
              `Repository was downloaded, but Boot could not switch to ${quoteUserValue(
                repository.ref ?? "the requested branch",
              )}. Check that the branch exists, then retry.`,
            );
          }
          applied.push({ kind: "repository", name: repository.id });
        } else if (item.action === "checkout" && repository.ref) {
          await checkoutBranch(repositoryPath, repository.ref);
          applied.push({ kind: "repository", name: repository.id });
        } else if (item.action === "conflict") {
          throw new Error(item.detail ?? "Existing repository files conflict with boot.yaml.");
        }
      } catch (error) {
        failures.push({
          kind: "repository",
          name: repository.id,
          message: sanitizeUserText((error as Error).message),
        });
      }
    }

    const bootEnvironment = plan.environment.filter(
      (requirement) => requirement.availableFrom === "boot",
    );
    if (options.materializeEnv !== false && bootEnvironment.length > 0) {
      try {
        if (!isLinked(absoluteRoot)) {
          throw new Error(
            "This workspace is not linked, so saved environment variables cannot be written. Link the workspace, then retry.",
          );
        }
        if (!keyExists()) {
          throw new Error(
            "No Boot secret key is installed on this machine. Run `boot env key receive` or `boot env key import`, then retry.",
          );
        }
        const names = new Set(bootEnvironment.map((requirement) => requirement.name));
        const repositoryPaths = new Set(
          workspace.repositories.map((repository) => repository.path),
        );
        const written = await materializeSelected(
          absoluteRoot,
          mapPaths(absoluteRoot).mapDir,
          await loadKey(),
          names,
          repositoryPaths,
        );
        for (const result of written) {
          applied.push({ kind: "environment", name: result.scope.type });
        }
      } catch (error) {
        failures.push({
          kind: "environment",
          name: "required",
          message: sanitizeUserText((error as Error).message),
        });
      }
    }

    if (options.runSetup) {
      const setupCommands = Object.values(workspace.commands).filter(
        (command) => command.id === "setup" || command.id.endsWith("-setup"),
      );
      for (const command of setupCommands) {
        const repository = command.repository ? byId.get(command.repository) : undefined;
        const cwd = repository
          ? resolveWithinRoot(absoluteRoot, repository.path)
          : absoluteRoot;
        try {
          const result = await execaCommand(command.run, {
            cwd,
            shell: true,
            reject: false,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          });
          if (result.exitCode !== 0) {
            throw new Error(`exited with status ${result.exitCode}`);
          }
          applied.push({ kind: "command", name: command.id });
        } catch (error) {
          failures.push({
            kind: "command",
            name: command.id,
            message: sanitizeUserText((error as Error).message),
          });
        }
      }
    }

    const finalPlan = await this.inspect(absoluteRoot, workspace);
    return {
      plan: finalPlan,
      applied,
      failures,
      ready: finalPlan.ready && failures.length === 0,
    };
  }
}

export function getWorkspaceProvider(name: string): WorkspaceProvider {
  if (name === "local") return new LocalWorkspaceProvider();
  throw new Error(
    `Workspace provider ${quoteUserValue(name)} is not supported. Available provider: local.`,
  );
}
