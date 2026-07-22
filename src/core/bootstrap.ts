import path from "node:path";
import { CONTEXT_VERSION, writeWorkspaceContext } from "./context";
import { buildWorkspaceDiagnostics, type WorkspaceDiagnostics } from "./diagnostics";
import { materializeAll } from "./env";
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
  eager?: boolean;
  hydrate?: string[];
  all?: boolean;
  folder?: boolean;
}

export interface BootstrapFailure {
  kind: "repository" | "environment" | "command";
  name: string;
  message: string;
}

interface BootstrapBase {
  schemaVersion: typeof BOOTSTRAP_RESULT_VERSION;
  root: string;
  source: {
    kind: WorkspaceSourceKind;
    state: WorkspaceSourceState;
  };
  dryRun: boolean;
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
  mode: BootstrapResult["mode"];
  source: BootstrapResult["source"];
  dryRun: boolean;
  ready: boolean;
  diagnostics: WorkspaceDiagnostics;
  applied: RealizationResult["applied"];
  failures: RealizationResult["failures"];
  warnings: string[];
}

export interface CompatibilityBootstrapOutput {
  schemaVersion: typeof BOOTSTRAP_RESULT_VERSION;
  mode: BootstrapResult["mode"];
  source: BootstrapResult["source"];
  dryRun: boolean;
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
  const initialPlan = await provider.plan(planningRoot, workspace);
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
      source: { kind: source.kind, state: source.state },
      dryRun: true,
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
  const stateWarning = await recordMachineState(root, source);
  if (stateWarning) warnings.push(stateWarning);

  return {
    schemaVersion: BOOTSTRAP_RESULT_VERSION,
    mode: "workspace",
    root: path.resolve(root),
    source: { kind: source.kind, state: source.state },
    dryRun: false,
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
  const failures: BootstrapFailure[] = reconciliation.failures.map((failure) => ({
    kind: "repository",
    name: failure.relativePath,
    message: failure.message,
  }));
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
        if (outcome === "hydrated") {
          completed.push(repository.relativePath);
        } else if (outcome === "hydrated-checkout-failed") {
          completed.push(repository.relativePath);
          failures.push({
            kind: "repository",
            name: repository.relativePath,
            message: "repository was cloned, but its saved branch could not be checked out",
          });
        }
      } catch (error) {
        failures.push({
          kind: "repository",
          name: repository.relativePath,
          message: sanitizeUserText((error as Error).message),
        });
      }
    }
  }

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
  if (!options.dryRun) {
    const stateWarning = await recordMachineState(root, source);
    if (stateWarning) warnings.push(stateWarning);
  }

  return {
    schemaVersion: BOOTSTRAP_RESULT_VERSION,
    mode: "compatibility",
    root: path.resolve(root),
    source: { kind: source.kind, state: source.state },
    dryRun: Boolean(options.dryRun),
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
  const root = path.resolve(workspacePath);
  const source = await openWorkspaceSource(remote, root, {
    folder: options.folder,
    dryRun: options.dryRun,
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
    return {
      schemaVersion: result.schemaVersion,
      mode: result.mode,
      source: result.source,
      dryRun: result.dryRun,
      ready: result.ready,
      diagnostics: buildWorkspaceDiagnostics(result.plan, result.root),
      applied: result.applied,
      failures: result.failures,
      warnings: result.warnings,
    };
  }
  return {
    schemaVersion: result.schemaVersion,
    mode: result.mode,
    source: result.source,
    dryRun: result.dryRun,
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
  };
}
