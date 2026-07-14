import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { buildManifest, writeManifest } from "../core/manifest";
import { scanWorkspace } from "../core/scanner";
import { colors, logger } from "../ui/logger";

export interface ScanOptions {
  output: string;
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function scanCommand(workspacePath: string, options: ScanOptions): Promise<void> {
  await ensureGitAvailable();

  const result = await scanWorkspace(workspacePath);
  const manifest = buildManifest({
    rootName: result.rootName,
    sourcePath: result.sourcePath,
    config: {
      ignoreFiles: result.ignoreFiles,
      defaultIgnoreRules: result.defaultIgnoreRules,
    },
    repos: result.repos,
  });
  const outPath = await writeManifest(options.output, manifest);

  logger.heading(`Snapshot workspace — ${colors.cyan(result.rootName)}`);
  logger.info(
    `Found ${colors.bold(String(result.repos.length))} ${
      result.repos.length === 1 ? "repository" : "repositories"
    }.`,
  );

  for (const repo of result.repos) {
    const state = repo.dirty ? colors.yellow("dirty") : colors.green("clean");
    const remote = repo.remoteUrl ? "" : colors.dim(" (no remote)");
    const tag = repo.hydrate.status === "placeholder" ? colors.dim(" [placeholder]") : "";
    logger.info(
      `  ${repo.relativePath}  ${colors.dim(repo.projectType)}  ${state}${remote}${tag}`,
    );
  }

  if (result.config.sourcePath) {
    logger.info();
    logger.info(
      `Config: ${colors.cyan(result.config.sourcePath)} (placeholder setup: ${
        result.config.hydrateStrategy
      })`,
    );
  }
  if (result.ignoreFiles.length > 0) {
    const total = result.ignoreFiles.reduce((n, f) => n + f.rules.length, 0);
    logger.info(
      `Ignore files: ${result.ignoreFiles.length} (${total} ${
        total === 1 ? "rule" : "rules"
      } applied)`,
    );
  }

  logger.info();
  logger.success(
    `Wrote snapshot to ${colors.cyan(path.relative(process.cwd(), outPath) || outPath)}.`,
  );
  const target = path.resolve(`${result.rootName}-restored`);
  logger.next(
    `Restore it with placeholders: boot import ${commandArg(outPath)} ${commandArg(
      target,
    )} --lazy`,
  );
}
