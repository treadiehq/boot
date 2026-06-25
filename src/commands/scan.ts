import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { buildManifest, writeManifest } from "../core/manifest";
import { scanWorkspace } from "../core/scanner";
import { colors, logger } from "../ui/logger";

export interface ScanOptions {
  output: string;
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

  logger.heading(`boot — scanned ${colors.cyan(result.rootName)}`);
  logger.info(`Found ${colors.bold(String(result.repos.length))} repo(s)`);

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
    logger.info(`Config: ${colors.cyan(result.config.sourcePath)} (hydrate: ${result.config.hydrateStrategy})`);
  }
  if (result.ignoreFiles.length > 0) {
    const total = result.ignoreFiles.reduce((n, f) => n + f.rules.length, 0);
    logger.info(`Ignore files: ${result.ignoreFiles.length} (${total} rule(s) applied)`);
  }

  logger.info();
  logger.success(
    `Manifest written to ${colors.cyan(path.relative(process.cwd(), outPath) || outPath)}`,
  );
  logger.next(`Recreate it elsewhere:  boot import ${path.basename(outPath)} <target> --lazy`);
  logger.next("Or sync continuously instead:  boot setup <map-remote>");
}
