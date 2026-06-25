#!/usr/bin/env node
import { run } from "./cli";
import { logger } from "./ui/logger";

run(process.argv).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
