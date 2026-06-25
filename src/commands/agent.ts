import path from "node:path";
import { materializeAll } from "../core/env";
import { ensureGitAvailable } from "../core/git";
import { hydratePlaceholder } from "../core/hydrate";
import { isLinked, mapPaths, readWorkspaceMap } from "../core/map";
import { reconcileFromMap } from "../core/reconcile";
import { scanWorkspace } from "../core/scanner";
import { keyExists, loadKey } from "../core/secrets";
import { loadTransport } from "../core/transport";
import { colors, logger } from "../ui/logger";
import { renderPlan, reconcileProgressHooks } from "../ui/plan";
import { stepPrefix } from "../ui/progress";
import { linkCommand } from "./link";

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

/** Turn a simple `*` glob into an anchored regex matched against a relativePath. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(relativePath));
}

/**
 * One-shot, non-interactive bootstrap for ephemeral environments (CI, cloud
 * agents, fresh containers). Idempotent: links the workspace on first run and
 * just pulls on subsequent runs, then optionally hydrates selected repos and
 * materializes env. Designed to be safe to run at the top of every job.
 */
export async function agentCommand(
  remote: string,
  workspacePath = ".",
  options: AgentOptions = {},
): Promise<void> {
  await ensureGitAvailable();
  const root = path.resolve(workspacePath);

  logger.heading(`Agent setup for ${colors.cyan(path.relative(process.cwd(), root) || ".")}`);

  if (options.dryRun) {
    await agentDryRun(remote, root, options);
    return;
  }

  if (isLinked(root)) {
    // Already bootstrapped — just bring it up to date and re-apply structure.
    logger.success("already linked — pulling latest map");
    const paths = mapPaths(root);
    const transport = await loadTransport(root);
    await transport.pull();
    const map = await readWorkspaceMap(paths.mapDir);
    if (map) {
      const recon = await reconcileFromMap(root, map.repos, {
        eager: options.eager,
        hooks: reconcileProgressHooks(),
      });
      if (recon.placeholders > 0) logger.success(`ensured ${recon.placeholders} placeholder(s)`);
      if (recon.cloned > 0) logger.success(`cloned ${recon.cloned} repo(s)`);
    }
  } else {
    await linkCommand(remote, root, { eager: options.eager, folder: options.folder });
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
    for (let i = 0; i < targets.length; i += 1) {
      const repo = targets[i]!;
      try {
        const outcome = await hydratePlaceholder(repo.absolutePath);
        if (outcome === "hydrated") {
          hydrated += 1;
          logger.info(
            `${stepPrefix(i + 1, targets.length)} hydrated ${colors.cyan(repo.relativePath)}`,
          );
        }
      } catch (err) {
        logger.error(`failed to hydrate ${repo.relativePath}: ${(err as Error).message}`);
      }
    }
    if (hydrated === 0 && targets.length === 0) {
      logger.info(colors.dim("no placeholders matched for hydration."));
    }
  }

  // Best-effort env materialization (skip silently when there's no key).
  if (options.env) {
    if (!keyExists()) {
      logger.warn("skipping env: no secret key on this machine (`boot env key import <key>`).");
    } else {
      const key = await loadKey();
      const written = await materializeAll(root, mapPaths(root).mapDir, key);
      if (written.length > 0) logger.success(`materialized ${written.length} .env file(s)`);
    }
  }

  logger.info();
  logger.success("Agent ready.");
}

/** Preview what `agent` would do, without linking, cloning, or writing env files. */
async function agentDryRun(remote: string, root: string, options: AgentOptions): Promise<void> {
  logger.info(colors.dim("(dry run — nothing will be written)"));
  logger.info();

  if (!isLinked(root)) {
    logger.info(`Would link ${colors.cyan(remote)} into ${colors.cyan(root)}.`);
    logger.info(
      colors.dim(
        options.eager
          ? "  then clone every repo in the map."
          : "  then create placeholders for every repo in the map.",
      ),
    );
    logger.next("Run without --dry-run to bootstrap.");
    return;
  }

  const paths = mapPaths(root);
  const transport = await loadTransport(root);
  await transport.pull();
  const map = await readWorkspaceMap(paths.mapDir);
  if (!map) {
    logger.warn("the map has no workspace.json yet — nothing to do.");
    return;
  }

  const plan = await reconcileFromMap(root, map.repos, { eager: options.eager, dryRun: true });
  renderPlan(plan);

  const patterns = options.hydrate ?? [];
  if (options.all || patterns.length > 0) {
    const scan = await scanWorkspace(root);
    const targets = scan.repos.filter(
      (repo) =>
        repo.hydrate.status === "placeholder" &&
        (options.all || matchesAny(repo.relativePath, patterns)),
    );
    logger.info();
    logger.info(`Would hydrate ${colors.bold(String(targets.length))} placeholder(s):`);
    for (const t of targets) logger.info(colors.dim(`  \u2193 ${t.relativePath}`));
  }

  if (options.env) {
    logger.info();
    logger.info(
      keyExists()
        ? "Would materialize env vars (secret key present)."
        : colors.dim("Would skip env: no secret key on this machine."),
    );
  }
}
