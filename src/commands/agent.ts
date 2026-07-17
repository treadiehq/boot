import path from "node:path";
import { materializeAll } from "../core/env";
import { ensureGitAvailable } from "../core/git";
import { hydratePlaceholder } from "../core/hydrate";
import { withWorkspaceMapLock } from "../core/lock";
import { isLinked, mapPaths, readWorkspaceMap } from "../core/map";
import { reconcileFromMap, type ReconcileResult } from "../core/reconcile";
import { scanWorkspace } from "../core/scanner";
import { keyExists, loadKey } from "../core/secrets";
import { loadTransport } from "../core/transport";
import { readPublishedWorkspace } from "../core/workspaceStore";
import { colors, logger } from "../ui/logger";
import { renderPlan, renderReconcileFailures, reconcileProgressHooks } from "../ui/plan";
import { stepPrefix } from "../ui/progress";
import { linkCommand } from "./link";
import { upCommand } from "./up";

export interface AgentOptions {
  /** Clone every repo up front instead of writing placeholders. */
  eager?: boolean;
  /** Glob-ish patterns (matched on relativePath) to hydrate after setup. */
  hydrate?: string[];
  /** Hydrate every placeholder. */
  all?: boolean;
  /** Materialize env vars if a secret key is present. */
  env?: boolean;
  /** Treat <remote> as an already-synced folder instead of a git URL. */
  folder?: boolean;
  /** Show what would change without writing anything. */
  dryRun?: boolean;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Turn a simple `*` glob into an anchored regex matched against a relativePath. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(relativePath));
}

function hasLegacyMaterializationOverrides(options: AgentOptions): boolean {
  return Boolean(options.eager) || Boolean(options.all) || (options.hydrate?.length ?? 0) > 0;
}

/**
 * One-shot, non-interactive bootstrap for ephemeral environments (CI, cloud
 * agents, fresh containers). Idempotent: links the workspace on first run and
 * just pulls on subsequent runs, then optionally hydrates selected repos and
 * writes environment files. Designed to be safe to run at the top of every job.
 */
export async function agentCommand(
  remote: string,
  workspacePath = ".",
  options: AgentOptions = {},
): Promise<void> {
  await ensureGitAvailable();
  const root = path.resolve(workspacePath);

  logger.heading(`Set up agent workspace — ${colors.cyan(path.relative(process.cwd(), root) || ".")}`);

  if (options.dryRun) {
    await agentDryRun(remote, root, options);
    return;
  }

  let eagerFailures: ReconcileResult["failures"] = [];
  if (isLinked(root)) {
    // Already bootstrapped — just bring it up to date and re-apply structure.
    logger.success("The workspace map is already linked. Pulling latest changes.");
    await withWorkspaceMapLock(root, async () => {
      const paths = mapPaths(root);
      const transport = await loadTransport(root);
      await transport.pull();
      const map = await readWorkspaceMap(paths.mapDir);
      if (map) {
        const recon = await reconcileFromMap(root, map.repos, {
          eager: options.eager,
          hooks: reconcileProgressHooks(),
        });
        if (recon.placeholders > 0) {
          logger.success(
            `Prepared ${recon.placeholders} repository ${
              recon.placeholders === 1 ? "placeholder" : "placeholders"
            }.`,
          );
        }
        if (recon.cloned > 0) {
          logger.success(
            `Cloned ${recon.cloned} ${recon.cloned === 1 ? "repository" : "repositories"}.`,
          );
        }
        eagerFailures = recon.failures;
        renderReconcileFailures(recon.failures);
      }
    });
  } else {
    await linkCommand(remote, root, { eager: options.eager, folder: options.folder });
  }

  if (eagerFailures.length > 0) {
    const extraFlags = `${options.folder ? " --folder" : ""}${options.env ? " --env" : ""}`;
    throw new Error(
      `The agent workspace is not ready: ${eagerFailures.length} ${
        eagerFailures.length === 1 ? "repository" : "repositories"
      } could not be cloned. Fix the reported problems, then run: boot agent ${commandArg(remote)} ${commandArg(root)} --eager${extraFlags}`,
    );
  }

  const published = await readPublishedWorkspace(mapPaths(root).mapDir);
  if (published && !hasLegacyMaterializationOverrides(options)) {
    await upCommand(root, {
      profile: published.profiles?.agent ? "agent" : undefined,
      provider: "local",
      env: options.env,
    });
    return;
  }

  // Selective hydration of placeholders by pattern (or all).
  const patterns = options.hydrate ?? [];
  if (options.all || patterns.length > 0) {
    const scan = await scanWorkspace(root);
    const targets = scan.repos.filter(
      (repo) =>
        repo.hydrate.status === "placeholder" &&
        (options.all || matchesAny(repo.relativePath, patterns)),
    );
    let hydrated = 0;
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i += 1) {
      const repo = targets[i]!;
      try {
        const outcome = await hydratePlaceholder(repo.absolutePath);
        if (outcome === "hydrated" || outcome === "hydrated-checkout-failed") {
          hydrated += 1;
          logger.info(
            `${stepPrefix(i + 1, targets.length)} cloned ${colors.cyan(repo.relativePath)}`,
          );
          if (outcome === "hydrated-checkout-failed") {
            logger.warn(`${repo.relativePath}: cloned, but the saved branch could not be checked out`);
            failures.push(`${repo.relativePath}: checkout failed`);
          }
        }
      } catch (err) {
        logger.error(`Could not clone ${repo.relativePath}: ${(err as Error).message}`);
        failures.push(`${repo.relativePath}: ${(err as Error).message}`);
      }
    }
    if (hydrated === 0 && targets.length === 0) {
      logger.info(colors.dim("No repository placeholders matched."));
    }
    if (failures.length > 0) {
      throw new Error(
        `The agent workspace is not ready: ${failures.length} ${
          failures.length === 1 ? "repository was" : "repositories were"
        } not prepared.`,
      );
    }
  }

  // Best-effort environment-file writing (skip silently when there's no key).
  if (options.env) {
    if (!keyExists()) {
      logger.warn("Skipped .env files because this machine has no secret key.");
      logger.next("Import a key: boot env key import");
      logger.next(`Then write .env files: boot env materialize -C ${commandArg(root)}`);
    } else {
      const key = await loadKey();
      const written = await materializeAll(root, mapPaths(root).mapDir, key);
      if (written.length > 0) {
        logger.success(
          `Wrote ${written.length} ${written.length === 1 ? ".env file" : ".env files"}.`,
        );
      }
    }
  }

  logger.info();
  logger.success("Agent workspace ready.");
}

/** Preview what `agent` would do, without linking, cloning, or writing env files. */
async function agentDryRun(remote: string, root: string, options: AgentOptions): Promise<void> {
  logger.info(colors.dim("Dry run: no files will be written."));
  logger.info();

  if (!isLinked(root)) {
    logger.info(`Would link workspace map ${colors.cyan(remote)} to ${colors.cyan(root)}.`);
    logger.info(
      colors.dim(
        options.eager
          ? "  Then clone every repository in the map."
          : "  Then create a placeholder for each repository. A placeholder clones on demand.",
      ),
    );
    logger.next("Run the same command without --dry-run to set up the workspace.");
    return;
  }

  const paths = mapPaths(root);
  const published = await readPublishedWorkspace(paths.mapDir);
  const map = await readWorkspaceMap(paths.mapDir);
  if (!map) {
    logger.warn("The cached workspace map is empty, so there is nothing to do.");
  } else {
    logger.info(colors.dim("Using the cached workspace map without pulling changes."));

    const plan = await reconcileFromMap(root, map.repos, { eager: options.eager, dryRun: true });
    renderPlan(plan);
  }

  if (published && !hasLegacyMaterializationOverrides(options)) {
    logger.info();
    await upCommand(root, {
      profile: published.profiles?.agent ? "agent" : undefined,
      provider: "local",
      env: options.env,
      dryRun: true,
    });
    return;
  }
  if (!map) return;

  const patterns = options.hydrate ?? [];
  if (options.all || patterns.length > 0) {
    const scan = await scanWorkspace(root);
    const targets = scan.repos.filter(
      (repo) =>
        repo.hydrate.status === "placeholder" &&
        (options.all || matchesAny(repo.relativePath, patterns)),
    );
    logger.info();
    logger.info(
      `Would clone ${colors.bold(String(targets.length))} ${
        targets.length === 1 ? "repository" : "repositories"
      } from placeholders:`,
    );
    for (const t of targets) logger.info(colors.dim(`  \u2193 ${t.relativePath}`));
  }

  if (options.env) {
    logger.info();
    logger.info(
      keyExists()
        ? "Would write .env files because a secret key is installed."
        : colors.dim("Would skip .env files because this machine has no secret key."),
    );
  }
}
