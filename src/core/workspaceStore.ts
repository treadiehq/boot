import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileAtomic } from "./files";
import { workspaceDefinitionSchema, type WorkspaceDefinition } from "./workspace";
import {
  fileReadError,
  isFileNotFoundError,
  quoteUserValue,
  sanitizeUserText,
} from "./userErrors";

export const PUBLISHED_WORKSPACE_FILE = "boot.yaml";

export async function readPublishedWorkspace(
  mapDir: string,
): Promise<WorkspaceDefinition | null> {
  const filePath = path.join(mapDir, PUBLISHED_WORKSPACE_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return null;
    throw fileReadError("shared workspace file", filePath, error);
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    const reason = sanitizeUserText((error as Error).message);
    throw new Error(
      `Shared workspace file at ${quoteUserValue(filePath, 500)} is not valid YAML${reason ? `: ${reason}` : "."} Run \`boot save .\` from the source workspace to replace it.`,
    );
  }
  const result = workspaceDefinitionSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Shared workspace file at ${quoteUserValue(filePath, 500)} has an invalid format. Run \`boot save .\` from the source workspace to replace it.`,
    );
  }
  return result.data;
}

export async function writePublishedWorkspace(
  mapDir: string,
  definition: WorkspaceDefinition,
): Promise<void> {
  const validated = workspaceDefinitionSchema.parse(definition);
  await writeFileAtomic(
    path.join(mapDir, PUBLISHED_WORKSPACE_FILE),
    stringifyYaml(validated, { lineWidth: 0 }),
  );
}
