import fs from "node:fs/promises";
import path from "node:path";
import { ensureGitAvailable, gitRemoteProbe } from "../core/git";
import {
  ghAvailable,
  ghCreatePrivateRepo,
  isRepoNotFoundError,
  parseGitHubSlug,
} from "../core/github";
import { loadMachineIdentity } from "../core/identity";
import {
  emptyWorkspaceMap,
  isLinked,
  mapPaths,
  machineStateFromScan,
  mergeReposIntoMap,
  mergeWorkspaceDefinitionIntoMap,
  readWorkspaceMap,
  sharedRepoFromEntry,
  shortId,
  writeLinkConfig,
  writeMachineState,
  writeWorkspaceMap,
} from "../core/map";
import { reconcileFromMap } from "../core/reconcile";
import { scanWorkspace } from "../core/scanner";
import { cloneMap, initFolderMap, type MapTransport } from "../core/transport";
import { writePublishedWorkspace } from "../core/workspaceStore";
import { colors, logger } from "../ui/logger";
import { renderReconcileFailures, reconcileProgressHooks } from "../ui/plan";
import { withSpinner } from "../ui/progress";
import { confirm, isInteractive } from "../ui/prompt";

export interface LinkOptions {
  eager?: boolean;
  /** Treat <remote> as an already-synced folder (Dropbox/Drive/…) instead of a git URL. */
  folder?: boolean;
  /** Accept prompts (e.g. create a missing map remote) without asking. */
  yes?: boolean;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Make sure the map remote exists before we try to clone it. If it doesn't and
 * it's a GitHub URL with `gh` on PATH, offer to create it as a private repo on
 * the spot — the "go make an empty repo first" step is the single biggest
 * onboarding speed bump. Auth/network failures are left for clone to report.
 */
export async function ensureMapRemoteExists(
  remote: string,
  options: { yes?: boolean; workspacePath?: string } = {},
): Promise<void> {
  const probe = await gitRemoteProbe(remote);
  if (probe.ok || !isRepoNotFoundError(probe.detail)) return;

  const slug = parseGitHubSlug(remote);
  const canCreate = slug !== null && (await ghAvailable());

  if (canCreate) {
    const create =
      options.yes ||
      (isInteractive() &&
        (await confirm(
          `No workspace map found. Create ${colors.cyan(slug)} as a private GitHub repository?`,
          {
            default: true,
          },
        )));
    if (create) {
      await withSpinner(`creating ${slug} on GitHub`, () => ghCreatePrivateRepo(slug));
      return;
    }
  }

  const retry = `boot link ${commandArg(remote)} ${commandArg(options.workspacePath ?? ".")} --yes`;
  if (slug && canCreate) {
    throw new Error(
      `No workspace map found at ${remote}.\nCreate it and link this workspace: ${retry}`,
    );
  }
  if (slug) {
    throw new Error(
      `No workspace map found at ${remote}.\n` +
        `Create an empty private repository at https://github.com/new, then run: ` +
        `boot link ${commandArg(remote)} ${commandArg(options.workspacePath ?? ".")}`,
    );
  }
  throw new Error(
    `No workspace map found at ${remote}.\nCreate an empty private repository there, then run: ` +
      `boot link ${commandArg(remote)} ${commandArg(options.workspacePath ?? ".")}`,
  );
}

/**
 * Connect a workspace to a shared boot map: clone the map, publish whatever is
 * already here, and recreate the structure for anything that only exists on
 * other machines. Works in both directions, so the very first machine seeds the
 * map and every later machine receives it.
 */
export async function linkCommand(
  remote: string,
  workspacePath = ".",
  options: LinkOptions = {},
): Promise<void> {
  await ensureGitAvailable();

  const root = path.resolve(workspacePath);
  await fs.mkdir(root, { recursive: true });

  const paths = mapPaths(root);
  if (isLinked(root)) {
    throw new Error(
      `This workspace is already linked. Pull changes with: boot pull ${commandArg(root)}`,
    );
  }

  const kind = options.folder ? "folder" : "git";
  logger.heading(
    `Linking ${colors.cyan(root)} to ${colors.cyan(remote)}${
      options.folder ? colors.dim(" (folder)") : ""
    }`,
  );

  if (!options.folder) {
    await ensureMapRemoteExists(remote, { yes: options.yes, workspacePath: root });
  }

  const identity = await loadMachineIdentity();
  await fs.mkdir(paths.bootDir, { recursive: true });

  const transport: MapTransport = options.folder
    ? await withSpinner("syncing workspace map from folder", () =>
        initFolderMap(remote, paths.mapDir),
      )
    : await withSpinner("cloning workspace map", () => cloneMap(remote, paths.mapDir));

  let map = emptyWorkspaceMap(path.basename(root));
  try {
    map = (await readWorkspaceMap(paths.mapDir)) ?? map;
  } catch (error) {
    // Transport initialization succeeded, so this command created mapDir.
    // Roll it back when the imported map is invalid so a corrected retry can
    // initialize cleanly instead of being mistaken for an existing link.
    await fs.rm(paths.mapDir, { recursive: true, force: true });
    throw error;
  }
  await writeLinkConfig(root, { kind, remote, linkedAt: new Date().toISOString() });

  // Publish what this machine already has into the shared map.
  const scan = await scanWorkspace(root);
  map = mergeReposIntoMap(map, scan.repos.map(sharedRepoFromEntry), {
    ignoreFiles: scan.ignoreFiles,
    defaultIgnoreRules: scan.defaultIgnoreRules,
  });
  if (scan.config.definition) {
    map = mergeWorkspaceDefinitionIntoMap(map, scan.config.definition);
    await writePublishedWorkspace(paths.mapDir, scan.config.definition);
  }
  await writeWorkspaceMap(paths.mapDir, map);

  // Recreate structure for repos that only exist elsewhere.
  const recon = await reconcileFromMap(root, map.repos, {
    eager: options.eager,
    hooks: reconcileProgressHooks(),
  });
  if (recon.placeholders > 0) {
    logger.success(
      `Prepared ${recon.placeholders} repository ${
        recon.placeholders === 1 ? "placeholder" : "placeholders"
      }. Each placeholder clones its repository on first use.`,
    );
  }
  if (recon.cloned > 0) {
    logger.success(
      `Cloned ${recon.cloned} ${recon.cloned === 1 ? "repository" : "repositories"}.`,
    );
  }
  renderReconcileFailures(recon.failures);

  // Register this machine (rescan so freshly-written placeholders are included).
  const rescan = await scanWorkspace(root);
  await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, rescan.repos));

  await transport.push(`link: ${identity.hostname} (${shortId(identity.machineId)})`);

  if (recon.failures.length > 0) {
    throw new Error(
      `The workspace was linked, but ${recon.failures.length} ${
        recon.failures.length === 1 ? "repository" : "repositories"
      } could not be cloned. Fix the reported problems, then run: boot pull ${commandArg(root)} --eager`,
    );
  }

  logger.info();
  logger.success(
    `Linked as ${colors.cyan(identity.hostname)}. The workspace map has ${map.repos.length} ${
      map.repos.length === 1 ? "repository" : "repositories"
    }.`,
  );
  if (recon.placeholders > 0) {
    const placeholder = rescan.repos.find(
      (repository) => repository.hydrate.status === "placeholder" && repository.remoteUrl,
    );
    if (placeholder) {
      logger.next(`Clone one now: boot hydrate ${commandArg(placeholder.absolutePath)}`);
    }
  }
}
