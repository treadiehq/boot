import path from "node:path";
import { z } from "zod";
import { CONTEXT_VERSION, writeWorkspaceContext } from "./context";
import {
  buildWorkspaceDiagnostics,
  workspaceDiagnosticsSchema,
  type WorkspaceDiagnostics,
} from "./diagnostics";
import { materializeAll } from "./env";
import { fullGitShaSchema, parseFullGitSha } from "./git";
import { hydratePlaceholder } from "./hydrate";
import { loadMachineIdentity } from "./identity";
import { getWorkspaceProvider } from "./localProvider";
import { withWorkspaceMapLock } from "./lock";
import {
  emptyWorkspaceMap,
  machineStateFromScan,
  readWorkspaceMap,
  writeMachineState,
} from "./map";
import type {
  RealizationPlan,
  RealizationResult,
} from "./provider";
import { reconcileFromMap, type ReconcileResult } from "./reconcile";
import { scanWorkspace } from "./scanner";
import { keyExists, loadKey } from "./secrets";
import { sanitizeUserText } from "./userErrors";
import { resolveWorkspace, type WorkspaceDefinition } from "./workspace";
import { readPublishedWorkspace } from "./workspaceStore";
import {
  openWorkspaceSource,
  type WorkspaceSource,
  type WorkspaceSourceKind,
  type WorkspaceSourceState,
} from "./workspaceSource";

export const BOOTSTRAP_RESULT_VERSION = 1 as const;

export interface BootstrapOptions {
  profile?: string;
  provider?: string;
  dryRun?: boolean;
  env?: boolean;
  runSetup?: boolean;
  /** Run declared service start commands and wait until they report healthy. */
  startServices?: boolean;
  eager?: boolean;
  hydrate?: string[];
  all?: boolean;
  folder?: boolean;
  /** Exact Git map commit to realize. Real pinned runs must also be ephemeral. */
  mapCommit?: string;
  /** Realize target state without publishing machine or map state. */
  ephemeral?: boolean;
}

export interface BootstrapFailure {
  kind: "repository" | "environment" | "service" | "command";
  name: string;
  message: string;
}

interface BootstrapBase {
  schemaVersion: typeof BOOTSTRAP_RESULT_VERSION;
  root: string;
  source: {
    kind: WorkspaceSourceKind;
    state: WorkspaceSourceState;
    commit: string | null;
    pinned: boolean;
  };
  dryRun: boolean;
  ephemeral: boolean;
  warnings: string[];
  ready: boolean;
}

export interface WorkspaceBootstrapResult extends BootstrapBase {
  mode: "workspace";
  plan: RealizationPlan;
  applied: RealizationResult["applied"];
  failures: RealizationResult["failures"];
}

export interface CompatibilityBootstrapResult extends BootstrapBase {
  mode: "compatibility";
  reconciliation: ReconcileResult;
  hydration: {
    planned: string[];
    completed: string[];
  };
  environmentFiles: number;
  failures: BootstrapFailure[];
}

export type BootstrapResult =
  | WorkspaceBootstrapResult
  | CompatibilityBootstrapResult;

export interface WorkspaceBootstrapOutput {
  schemaVersion: typeof BOOTSTRAP_RESULT_VERSION;
  mode: "workspace";
  source: BootstrapResult["source"];
  dryRun: boolean;
  ephemeral: boolean;
  ready: boolean;
  diagnostics: WorkspaceDiagnostics;
  applied: RealizationResult["applied"];
  failures: RealizationResult["failures"];
  warnings: string[];
}

export interface CompatibilityBootstrapOutput {
  schemaVersion: typeof BOOTSTRAP_RESULT_VERSION;
  mode: "compatibility";
  source: BootstrapResult["source"];
  dryRun: boolean;
  ephemeral: boolean;
  ready: boolean;
  workspace: { root: string };
  reconciliation: {
    placeholders: number;
    cloned: number;
    skipped: number;
    plan: ReconcileResult["plan"];
  };
  hydration: CompatibilityBootstrapResult["hydration"];
  environmentFiles: number;
  failures: BootstrapFailure[];
  warnings: string[];
}

export type BootstrapOutput =
  | WorkspaceBootstrapOutput
  | CompatibilityBootstrapOutput;

const bootstrapSourceSchema = z
  .object({
    kind: z.enum(["git", "folder"]),
    state: z.enum(["linked", "updated", "cached", "preview"]),
    commit: fullGitShaSchema.nullable(),
    pinned: z.boolean(),
  })
  .strict();

const realizationItemSchema = z
  .object({
    kind: z.enum(["repository", "environment", "service", "command"]),
    name: z.string(),
  })
  .strict();

const bootstrapFailureSchema = realizationItemSchema
  .extend({ message: z.string() })
  .strict();

const workspaceBootstrapOutputSchema = z
  .object({
    schemaVersion: z.literal(BOOTSTRAP_RESULT_VERSION),
    mode: z.literal("workspace"),
    source: bootstrapSourceSchema,
    dryRun: z.boolean(),
    ephemeral: z.boolean(),
    ready: z.boolean(),
    diagnostics: workspaceDiagnosticsSchema,
    applied: z.array(realizationItemSchema),
    failures: z.array(bootstrapFailureSchema),
    warnings: z.array(z.string()),
  })
  .strict();

const compatibilityBootstrapOutputSchema = z
  .object({
    schemaVersion: z.literal(BOOTSTRAP_RESULT_VERSION),
    mode: z.literal("compatibility"),
    source: bootstrapSourceSchema,
    dryRun: z.boolean(),
    ephemeral: z.boolean(),
    ready: z.boolean(),
    workspace: z.object({ root: z.string() }).strict(),
    reconciliation: z
      .object({
        placeholders: z.number().int().nonnegative(),
        cloned: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        plan: z.array(
          z
            .object({
              relativePath: z.string(),
              action: z.enum(["clone", "placeholder"]),
            })
            .strict(),
        ),
      })
      .strict(),
    hydration: z
      .object({
        planned: z.array(z.string()),
        completed: z.array(z.string()),
      })
      .strict(),
    environmentFiles: z.number().int().nonnegative(),
    failures: z.array(bootstrapFailureSchema),
    warnings: z.array(z.string()),
  })
  .strict();

export const bootstrapOutputSchema = z.discriminatedUnion("mode", [
  workspaceBootstrapOutputSchema,
  compatibilityBootstrapOutputSchema,
]);

function hasCompatibilityOverrides(options: BootstrapOptions): boolean {
  return Boolean(options.eager) || Boolean(options.all) || (options.hydrate?.length ?? 0) > 0;
}

/** Turn a simple `*` path pattern into an anchored regular expression. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function profileForAgent(
  definition: WorkspaceDefinition,
  requested?: string,
): string | undefined {
  if (requested) return requested;
  return definition.profiles?.agent ? "agent" : undefined;
}

function bootstrapSource(source: WorkspaceSource): BootstrapResult["source"] {
  return {
    kind: source.kind,
    state: source.state,
    commit: source.commit,
    pinned: source.pinned,
  };
}

async function recordMachineState(
  root: string,
  source: WorkspaceSource,
): Promise<string | null> {
  if (!source.transport) return null;
  try {
    const [identity, scan] = await Promise.all([
      loadMachineIdentity(),
      scanWorkspace(root),
    ]);
    await withWorkspaceMapLock(root, async () => {
      await writeMachineState(
        source.mapDir,
        machineStateFromScan(identity, root, scan.repos),
      );
      await source.transport!.push(`boot: prepare agent workspace on ${identity.hostname}`);
    });
    return null;
  } catch (error) {
    return `Workspace preparation succeeded, but Boot could not publish this machine's state: ${
      sanitizeUserText((error as Error).message)
    }`;
  }
}

async function realizePublishedWorkspace(
  definition: WorkspaceDefinition,
  source: WorkspaceSource,
  root: string,
  options: BootstrapOptions,
): Promise<WorkspaceBootstrapResult> {
  const workspace = resolveWorkspace(
    definition,
    profileForAgent(definition, options.profile),
  );
  const provider = getWorkspaceProvider(options.provider ?? "local");
  const planningRoot = options.dryRun ? source.inspectionRoot : root;
  const initialPlan = await provider.plan(planningRoot, workspace, { probe: !options.dryRun });
  // A preview map may live under a temporary root. Repository paths and the
  // user-facing result still refer to the requested target.
  const plan =
    planningRoot === root
      ? initialPlan
      : { ...initialPlan, root: path.resolve(root) };

  if (options.dryRun) {
    return {
      schemaVersion: BOOTSTRAP_RESULT_VERSION,
      mode: "workspace",
      root: path.resolve(root),
      source: bootstrapSource(source),
      dryRun: true,
      ephemeral: Boolean(options.ephemeral),
      plan,
      applied: [],
      failures: [],
      warnings: [],
      ready: plan.ready,
    };
  }

  const realization = await provider.apply(root, workspace, plan, {
    materializeEnv: options.env !== false,
    runSetup: options.runSetup,
    startServices: options.startServices,
  });
  if (realization.ready) {
    await writeWorkspaceContext(root, {
      version: CONTEXT_VERSION,
      workspaceId: workspace.id,
      profile: workspace.profile,
      provider: provider.name,
      readyAt: new Date().toISOString(),
    });
  }

  const warnings: string[] = [];
  if (!options.ephemeral) {
    const stateWarning = await recordMachineState(root, source);
    if (stateWarning) warnings.push(stateWarning);
  }

  return {
    schemaVersion: BOOTSTRAP_RESULT_VERSION,
    mode: "workspace",
    root: path.resolve(root),
    source: bootstrapSource(source),
    dryRun: false,
    ephemeral: Boolean(options.ephemeral),
    plan: realization.plan,
    applied: realization.applied,
    failures: realization.failures,
    warnings,
    ready: realization.ready,
  };
}

function combineReconciliation(
  left: ReconcileResult,
  right: ReconcileResult,
): ReconcileResult {
  return {
    placeholders: left.placeholders + right.placeholders,
    cloned: left.cloned + right.cloned,
    skipped: left.skipped + right.skipped,
    plan: [...left.plan, ...right.plan],
    failures: [...left.failures, ...right.failures],
  };
}

async function realizeCompatibilityMap(
  source: WorkspaceSource,
  root: string,
  options: BootstrapOptions,
): Promise<CompatibilityBootstrapResult> {
  const map = (await readWorkspaceMap(source.mapDir)) ?? emptyWorkspaceMap(path.basename(root));
  const patterns = options.hydrate ?? [];
  const selectedPaths = map.repos
    .filter(
      (repository) =>
        options.eager ||
        options.all ||
        (patterns.length > 0 && matchesAny(repository.relativePath, patterns)),
    )
    .map((repository) => repository.relativePath);
  const selected = new Set(selectedPaths);
  const selectedRepos = map.repos.filter((repository) => selected.has(repository.relativePath));
  const remainingRepos = map.repos.filter((repository) => !selected.has(repository.relativePath));

  const selectedResult = await reconcileFromMap(root, selectedRepos, {
    eager: true,
    dryRun: options.dryRun,
  });
  const remainingResult = await reconcileFromMap(root, remainingRepos, {
    eager: Boolean(options.eager),
    dryRun: options.dryRun,
  });
  const reconciliation = combineReconciliation(selectedResult, remainingResult);
  const repositoryFailures = new Map<string, BootstrapFailure>(
    reconciliation.failures.map((failure) => [
      failure.relativePath,
      {
        kind: "repository",
        name: failure.relativePath,
        message: failure.message,
      },
    ]),
  );
  const completed: string[] = [];

  if (!options.dryRun && selectedPaths.length > 0) {
    const scan = await scanWorkspace(root);
    const targets = scan.repos.filter(
      (repository) =>
        repository.hydrate.status === "placeholder" &&
        selected.has(repository.relativePath),
    );
    for (const repository of targets) {
      try {
        const outcome = await hydratePlaceholder(repository.absolutePath);
        if (outcome === "hydrated" || outcome === "already-hydrated") {
          completed.push(repository.relativePath);
          repositoryFailures.delete(repository.relativePath);
        } else if (outcome === "hydrated-checkout-failed") {
          repositoryFailures.set(repository.relativePath, {
            kind: "repository",
            name: repository.relativePath,
            message: "repository was cloned, but its saved branch could not be checked out",
          });
        }
      } catch (error) {
        repositoryFailures.set(repository.relativePath, {
          kind: "repository",
          name: repository.relativePath,
          message: sanitizeUserText((error as Error).message),
        });
      }
    }
  }

  const failures = [...repositoryFailures.values()];
  let environmentFiles = 0;
  if (!options.dryRun && options.env === true) {
    if (!keyExists()) {
      failures.push({
        kind: "environment",
        name: "required",
        message: "No Boot secret key is installed. Import or receive the key, then retry.",
      });
    } else {
      try {
        environmentFiles = (
          await materializeAll(root, source.mapDir, await loadKey())
        ).length;
      } catch (error) {
        failures.push({
          kind: "environment",
          name: "required",
          message: sanitizeUserText((error as Error).message),
        });
      }
    }
  }

  const warnings: string[] = [];
  if (!options.dryRun && !options.ephemeral) {
    const stateWarning = await recordMachineState(root, source);
    if (stateWarning) warnings.push(stateWarning);
  }

  return {
    schemaVersion: BOOTSTRAP_RESULT_VERSION,
    mode: "compatibility",
    root: path.resolve(root),
    source: bootstrapSource(source),
    dryRun: Boolean(options.dryRun),
    ephemeral: Boolean(options.ephemeral),
    reconciliation,
    hydration: { planned: selectedPaths, completed },
    environmentFiles,
    failures,
    warnings,
    ready: failures.length === 0,
  };
}

/**
 * One-shot, provider-neutral bootstrap for fresh or existing agent machines.
 * Map transport acquisition is separate from provider realization: a published
 * workspace uses only its resolved profile, while map-only workspaces retain
 * the compatibility behavior.
 */
export async function bootstrapAgentWorkspace(
  remote: string,
  workspacePath = ".",
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const mapCommit = options.mapCommit
    ? parseFullGitSha(options.mapCommit)
    : undefined;
  if (mapCommit && !options.dryRun && !options.ephemeral) {
    throw new Error(
      "Pinned map runs must be ephemeral. Add `--ephemeral`, or use `--dry-run` to preview the pinned state.",
    );
  }
  if (mapCommit && options.folder) {
    throw new Error("Map commit pinning is available only for Git workspace maps.");
  }
  const root = path.resolve(workspacePath);
  const source = await openWorkspaceSource(remote, root, {
    folder: options.folder,
    dryRun: options.dryRun,
    mapCommit,
  });
  try {
    const definition = await readPublishedWorkspace(source.mapDir);
    if (definition && !hasCompatibilityOverrides(options)) {
      return await realizePublishedWorkspace(definition, source, root, options);
    }
    return await realizeCompatibilityMap(source, root, options);
  } finally {
    await source.cleanup();
  }
}

export function bootstrapOutput(result: BootstrapResult): BootstrapOutput {
  if (result.mode === "workspace") {
    return bootstrapOutputSchema.parse({
      schemaVersion: result.schemaVersion,
      mode: result.mode,
      source: result.source,
      dryRun: result.dryRun,
      ephemeral: result.ephemeral,
      ready: result.ready,
      diagnostics: buildWorkspaceDiagnostics(result.plan, result.root),
      applied: result.applied,
      failures: result.failures,
      warnings: result.warnings,
    });
  }
  return bootstrapOutputSchema.parse({
    schemaVersion: result.schemaVersion,
    mode: result.mode,
    source: result.source,
    dryRun: result.dryRun,
    ephemeral: result.ephemeral,
    ready: result.ready,
    workspace: { root: result.root },
    reconciliation: {
      placeholders: result.reconciliation.placeholders,
      cloned: result.reconciliation.cloned,
      skipped: result.reconciliation.skipped,
      plan: result.reconciliation.plan,
    },
    hydration: result.hydration,
    environmentFiles: result.environmentFiles,
    failures: result.failures,
    warnings: result.warnings,
  });
}
