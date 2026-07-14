import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  mode?: number;
}

/** Write a file completely, then atomically replace the destination. */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  try {
    await fs.writeFile(temporary, contents, {
      encoding: "utf8",
      mode: options.mode,
      flag: "wx",
    });
    await fs.rename(temporary, filePath);
    if (options.mode !== undefined) {
      await fs.chmod(filePath, options.mode);
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
