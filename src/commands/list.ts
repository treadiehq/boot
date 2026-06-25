import { readManifest } from "../core/manifest";
import { colors, logger } from "../ui/logger";

/**
 * Normalise a git remote into a compact, human-friendly form:
 *   git@github.com:dantelex2/kplane.git    -> github.com/dantelex2/kplane
 *   https://github.com/dantelex2/kplane.git -> github.com/dantelex2/kplane
 */
export function shortRemote(url: string | null): string {
  if (!url) return "(no remote)";
  let s = url.trim();
  s = s.replace(/^git@/, "");
  s = s.replace(/^ssh:\/\//, "");
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^git:\/\//, "");
  s = s.replace(/\.git$/, "");
  // First colon (scp-style separator) becomes a slash; ports are rare for our use.
  s = s.replace(":", "/");
  return s.replace(/\/+$/, "");
}

function statusLabel(status: "local" | "placeholder" | "hydrated"): string {
  switch (status) {
    case "placeholder":
      return colors.dim("placeholder");
    case "hydrated":
      return colors.cyan("hydrated");
    default:
      return colors.dim("local");
  }
}

export async function listCommand(manifestPath: string): Promise<void> {
  const manifest = await readManifest(manifestPath);

  logger.info(`Workspace: ${colors.cyan(manifest.workspace.rootName)}`);
  logger.info(`Repos: ${manifest.repos.length}`);

  if (manifest.repos.length === 0) return;

  const rows = manifest.repos.map((repo) => ({
    name: repo.name,
    remote: shortRemote(repo.remoteUrl),
    branch: repo.currentBranch ?? "(detached)",
    dirty: repo.dirty,
    status: repo.hydrate.status,
  }));

  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const remoteW = Math.max(6, ...rows.map((r) => r.remote.length));
  const branchW = Math.max(6, ...rows.map((r) => r.branch.length));

  logger.info();
  for (const row of rows) {
    const state =
      row.status === "placeholder"
        ? colors.dim("\u2014")
        : row.dirty
          ? colors.yellow("dirty")
          : colors.green("clean");
    logger.info(
      `${row.name.padEnd(nameW)}  ${row.remote.padEnd(remoteW)}  ${row.branch.padEnd(branchW)}  ${state.padEnd(5)}  ${statusLabel(row.status)}`,
    );
  }
}
