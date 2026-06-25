import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAME } from "../core/config";
import { IGNORE_FILE_NAME } from "../core/ignore";
import { colors, logger } from "../ui/logger";

export interface InitOptions {
  force?: boolean;
}

const DEFAULT_IGNORE_FILE = `node_modules/
.next/
dist/
build/
target/
.venv/
.cache/
.turbo/
.DS_Store
*.log
.env
.env.local
`;

function defaultConfigFile(workspaceName: string): string {
  return `workspace:
  name: ${workspaceName}
hydrate:
  strategy: manual
ignore:
  - node_modules
  - .next
  - dist
  - build
  - target
  - .venv
  - .cache
  - .turbo
doctor:
  defaultBranchNames:
    - main
    - master
  staleAfterDays: 30
daemon:
  intervalSeconds: 60
  fetch: true
  fastForward: true
`;
}

export async function initCommand(workspacePath: string, options: InitOptions = {}): Promise<void> {
  const root = path.resolve(workspacePath);

  const stat = await fs.stat(root).catch(() => null);
  if (!stat) {
    throw new Error(`Workspace path does not exist: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${root}`);
  }

  logger.heading(`boot init — ${colors.cyan(path.basename(root))}`);

  let created = 0;
  let skipped = 0;

  const write = async (fileName: string, contents: string): Promise<void> => {
    const filePath = path.join(root, fileName);
    if (existsSync(filePath) && !options.force) {
      logger.info(`${colors.dim("\u2022")} ${fileName} already exists (use --force to overwrite)`);
      skipped += 1;
      return;
    }
    await fs.writeFile(filePath, contents, "utf8");
    logger.success(`wrote ${fileName}`);
    created += 1;
  };

  await write(IGNORE_FILE_NAME, DEFAULT_IGNORE_FILE);
  await write(CONFIG_FILE_NAME, defaultConfigFile(path.basename(root)));

  logger.info();
  logger.info(`Created: ${created}, skipped: ${skipped}`);
  logger.next(`Edit ${IGNORE_FILE_NAME} to taste, then:  boot export ${path.basename(root)}`);
}
