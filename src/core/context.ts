import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./files";
import { BOOT_DIR_NAME } from "./map";
import { identifierSchema, workspaceIdSchema } from "./workspace";
import { fileReadError, isFileNotFoundError, quoteUserValue } from "./userErrors";

export const CONTEXT_VERSION = 1 as const;
export const CONTEXT_FILE_NAME = "context.json";

export const workspaceContextSchema = z
  .object({
    version: z.literal(CONTEXT_VERSION),
    workspaceId: workspaceIdSchema,
    profile: identifierSchema.nullable(),
    provider: identifierSchema,
    readyAt: z.string(),
  })
  .strict();

export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

export function workspaceContextPath(root: string): string {
  return path.join(path.resolve(root), BOOT_DIR_NAME, CONTEXT_FILE_NAME);
}

export async function readWorkspaceContext(root: string): Promise<WorkspaceContext | null> {
  const filePath = workspaceContextPath(root);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw fileReadError("workspace context", filePath, error);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Workspace context at ${quoteUserValue(filePath, 500)} is not valid JSON. Run \`boot up .\` from the workspace root to recreate it.`,
    );
  }

  const result = workspaceContextSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Workspace context at ${quoteUserValue(filePath, 500)} has an invalid format. Run \`boot up .\` from the workspace root to recreate it.`,
    );
  }
  return result.data;
}

export async function writeWorkspaceContext(
  root: string,
  context: WorkspaceContext,
): Promise<void> {
  await writeFileAtomic(workspaceContextPath(root), `${JSON.stringify(context, null, 2)}\n`);
}
