import { existsSync } from "node:fs";
import path from "node:path";
import { findWorkspaceRoot } from "../core/autohydrate";
import { hydratePlaceholder } from "../core/hydrate";
import { loadRepoChoices, rankRepos, type RankedRepo } from "../core/locate";
import { isPlaceholder } from "../core/placeholder";
import { colors, logger } from "../ui/logger";
import { isInteractive, select } from "../ui/prompt";

export interface CdOptions {
  /** Workspace directory (or anywhere inside it). Defaults to the cwd. */
  cwd?: string;
  /** Emit only the resolved path to stdout (consumed by the `bcd` shell fn). */
  print?: boolean;
  /** Emit the match as a single JSON line to stdout. */
  json?: boolean;
}

/** Max repos to show in the interactive browse list. */
const BROWSE_LIMIT = 30;

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve a repo in the map by fuzzy query, hydrate it if it's still a
 * placeholder, and surface its absolute path. The path is the product: the
 * `bcd` shell function captures `--print` output and `cd`s into it (a child
 * process can't change its parent shell's directory). With a query it jumps to
 * the best match; with none it offers an interactive browse list on a TTY.
 */
export async function cdCommand(query = "", options: CdOptions = {}): Promise<void> {
  // In structured modes stdout is reserved for the result, so route notes to stderr.
  const structured = Boolean(options.print || options.json);
  const note = (message: string): void => {
    if (structured) process.stderr.write(`${message}\n`);
    else logger.info(message);
  };

  const root = resolveWorkspaceRoot(options.cwd ?? ".");

  const choices = await loadRepoChoices(root);
  if (choices.length === 0) {
    throw new Error(
      `The workspace map has no repositories. Pull it again with: boot pull ${commandArg(root)}`,
    );
  }

  const ranked = rankRepos(query, choices);
  if (ranked.length === 0) {
    throw new Error(
      `No repository matches "${query}". Browse with \`boot cd -C ${commandArg(
        root,
      )}\`, or list them with: boot status ${commandArg(root)}`,
    );
  }

  const target = await pickRepo(ranked, query);

  if (!existsSync(target.absolutePath)) {
    throw new Error(
      `${target.relativePath} is missing. Prepare it again with: boot pull ${commandArg(root)}`,
    );
  }

  let hydrated = false;
  if (isPlaceholder(target.absolutePath)) {
    note(colors.dim(`cloning ${target.relativePath}…`));
    const outcome = await hydratePlaceholder(target.absolutePath);
    hydrated = true;
    if (outcome === "hydrated-checkout-failed") {
      note(colors.yellow(`cloned ${target.relativePath}, but could not check out its saved branch`));
    }
  }

  emit(target, hydrated, options);
}

/** Find the linked workspace at or above `cwd`, or fail with how to link one. */
function resolveWorkspaceRoot(cwd: string): string {
  const start = path.resolve(cwd);
  const root = findWorkspaceRoot(start);
  if (!root) {
    throw new Error(
      `No linked workspace found at or above ${start}. Run \`boot link --help\` to link one.`,
    );
  }
  return root;
}

/**
 * With a query, jump straight to the top-ranked repo. Without one, browse:
 * prompt on a TTY, otherwise (e.g. the shell function capturing output) refuse
 * rather than guess.
 */
async function pickRepo(ranked: RankedRepo[], query: string): Promise<RankedRepo> {
  if (query.trim().length > 0) return ranked[0]!;
  if (!isInteractive()) {
    throw new Error("Provide a repository name: boot cd <name>");
  }
  return select(
    "Jump to which repository?",
    ranked.slice(0, BROWSE_LIMIT).map((repo) => ({ label: repo.relativePath, value: repo })),
    { default: 0 },
  );
}

function emit(target: RankedRepo, hydrated: boolean, options: CdOptions): void {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        path: target.absolutePath,
        name: target.name,
        relativePath: target.relativePath,
        hydrated,
      })}\n`,
    );
    return;
  }
  if (options.print) {
    process.stdout.write(`${target.absolutePath}\n`);
    return;
  }
  // Human mode can't move the parent shell, so show the path and how to jump.
  logger.success(`${colors.cyan(target.relativePath)}${hydrated ? colors.dim(" (cloned)") : ""}`);
  logger.info(target.absolutePath);
  logger.next("Set up the `bcd` shell shortcut: boot shell-hook --help");
}
