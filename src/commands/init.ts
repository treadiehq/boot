import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { CONFIG_FILE_NAME } from "../core/config";
import { discoverWorkspace } from "../core/discovery";
import { writeFileAtomic } from "../core/files";
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

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function initCommand(workspacePath: string, options: InitOptions = {}): Promise<void> {
  const root = path.resolve(workspacePath);

  const stat = await fs.stat(root).catch(() => null);
  if (!stat) {
    throw new Error(`Path not found for workspace: ${root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a workspace directory: ${root}`);
  }

  logger.heading(`Initialize workspace — ${colors.cyan(path.basename(root))}`);

  let created = 0;
  let skipped = 0;
  let configContents = "";
  const shouldWriteConfig = options.force || !existsSync(path.join(root, CONFIG_FILE_NAME));
  if (shouldWriteConfig) {
    const discovery = await discoverWorkspace(root);
    configContents = stringifyYaml(
      {
        ...discovery.definition,
        hydrate: { strategy: "manual" },
        ignore: [
          "node_modules",
          ".next",
          "dist",
          "build",
          "target",
          ".venv",
          ".cache",
          ".turbo",
        ],
        doctor: {
          defaultBranchNames: ["main", "master"],
          staleAfterDays: 30,
        },
        daemon: {
          intervalSeconds: 60,
          fetch: true,
          fastForward: true,
        },
      },
      { lineWidth: 0 },
    );
    logger.info();
    logger.info("Found:");
    logger.info(
      `  ${discovery.repositories} ${
        discovery.repositories === 1 ? "repository" : "repositories"
      }`,
    );
    logger.info(
      `  ${discovery.services} ${discovery.services === 1 ? "local service" : "local services"}`,
    );
    logger.info(
      `  ${discovery.environmentRequirements} required environment ${
        discovery.environmentRequirements === 1 ? "variable" : "variables"
      }`,
    );
    logger.info(
      `  ${discovery.tools} ${discovery.tools === 1 ? "tool requirement" : "tool requirements"}`,
    );
    logger.info();
  }

  const write = async (fileName: string, contents: string): Promise<void> => {
    const filePath = path.join(root, fileName);
    if (existsSync(filePath) && !options.force) {
      logger.info(`${colors.dim("\u2022")} Kept ${fileName}. Use --force to overwrite it.`);
      skipped += 1;
      return;
    }
    await writeFileAtomic(filePath, contents);
    logger.success(`Wrote ${fileName}.`);
    created += 1;
  };

  await write(IGNORE_FILE_NAME, DEFAULT_IGNORE_FILE);
  await write(CONFIG_FILE_NAME, configContents);

  logger.info();
  logger.info(
    `Wrote ${created} ${created === 1 ? "file" : "files"}; kept ${skipped} existing ${
      skipped === 1 ? "file" : "files"
    }.`,
  );
  logger.next(
    `Review ${CONFIG_FILE_NAME}, then preview setup: boot up ${commandArg(root)} --dry-run`,
  );
}
