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
import { colors, logger } from "../ui/logger";
import { reconcileProgressHooks } from "../ui/plan";
import { withSpinner } from "../ui/progress";
import { confirm, isInteractive } from "../ui/prompt";

export interface LinkOptions {
  eager?: boolean;
  /** Treat <remote> as an already-synced folder (Dropbox/Drive/…) instead of a git URL. */
  folder?: boolean;
  /** Accept prompts (e.g. create a missing map remote) without asking. */
  yes?: boolean;
}

/**
 * Make sure the map remote exists before we try to clone it. If it doesn't and
 * it's a GitHub URL with `gh` on PATH, offer to create it as a private repo on
 * the spot — the "go make an empty repo first" step is the single biggest
 * onboarding speed bump. Auth/network failures are left for clone to report.
 */
export async function ensureMapRemoteExists(
  remote: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const probe = await gitRemoteProbe(remote);
  if (probe.ok || !isRepoNotFoundError(probe.detail)) return;

  const slug = parseGitHubSlug(remote);
  const canCreate = slug !== null && (await ghAvailable());

  if (canCreate) {
    const create =
      options.yes ||
      (isInteractive() &&
        (await confirm(`Map remote doesn't exist. Create ${colors.cyan(slug)} as a private GitHub repo?`, {
          default: true,
        })));
    if (create) {
      await withSpinner(`creating ${slug} on GitHub`, () => ghCreatePrivateRepo(slug));
      return;
    }
  }

  const fix = slug
    ? canCreate
      ? `  boot setup/link with --yes, or:  gh repo create ${slug} --private`
      : `  gh repo create ${slug} --private   (or create it empty+private at https://github.com/new)`
    : "  create an empty private repo on your git host, then re-run";
  throw new Error(`Map remote not found: ${remote}\nCreate it first, then re-run:\n${fix}`);
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
      `${root} is already linked (${paths.mapDir}). Use \`boot pull\` / \`boot push\` to sync.`,
    );
  }

  const kind = options.folder ? "folder" : "git";
  logger.heading(
    `Linking ${colors.cyan(root)} to ${colors.cyan(remote)}${
      options.folder ? colors.dim(" (folder)") : ""
    }`,
  );

  if (!options.folder) {
    await ensureMapRemoteExists(remote, { yes: options.yes });
  }

  const identity = await loadMachineIdentity();
  await fs.mkdir(paths.bootDir, { recursive: true });

  const transport: MapTransport = options.folder
    ? await withSpinner("syncing map from folder", () => initFolderMap(remote, paths.mapDir))
    : await withSpinner("cloning map", () => cloneMap(remote, paths.mapDir));

  let map = (await readWorkspaceMap(paths.mapDir)) ?? emptyWorkspaceMap(path.basename(root));
  await writeLinkConfig(root, { kind, remote, linkedAt: new Date().toISOString() });

  // Publish what this machine already has into the shared map.
  const scan = await scanWorkspace(root);
  map = mergeReposIntoMap(map, scan.repos.map(sharedRepoFromEntry), {
    ignoreFiles: scan.ignoreFiles,
    defaultIgnoreRules: scan.defaultIgnoreRules,
  });
  await writeWorkspaceMap(paths.mapDir, map);

  // Recreate structure for repos that only exist elsewhere.
  const recon = await reconcileFromMap(root, map.repos, {
    eager: options.eager,
    hooks: reconcileProgressHooks(),
  });
  if (recon.placeholders > 0) logger.success(`created ${recon.placeholders} placeholder(s)`);
  if (recon.cloned > 0) logger.success(`cloned ${recon.cloned} repo(s)`);

  // Register this machine (rescan so freshly-written placeholders are included).
  const rescan = await scanWorkspace(root);
  await writeMachineState(paths.mapDir, machineStateFromScan(identity, root, rescan.repos));

  await transport.push(`link: ${identity.hostname} (${shortId(identity.machineId)})`);

  logger.info();
  logger.success(
    `Linked as ${colors.cyan(identity.hostname)}. ${map.repos.length} repo(s) in the map.`,
  );
  if (recon.placeholders > 0) {
    logger.info(colors.dim("Hydrate a repo with:  boot hydrate <relativePath>"));
  }
}
