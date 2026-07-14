import path from "node:path";
import { loadConfig } from "../core/config";
import { isLinked, mapPaths } from "../core/map";
import { withWorkspaceMapLock } from "../core/lock";
import { loadTransport } from "../core/transport";
import { writePublishedWorkspace } from "../core/workspaceStore";
import { colors, logger } from "../ui/logger";

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Publish the workspace definition through the existing map transport. */
export async function saveCommand(workspacePath = "."): Promise<void> {
  const root = path.resolve(workspacePath);
  const config = await loadConfig(root);
  if (!config.definition) {
    throw new Error(`No boot.yaml found. Create one with: boot init ${commandArg(root)}`);
  }
  if (!isLinked(root)) {
    throw new Error(
      `This workspace is not linked. Run: boot link <map-remote> ${commandArg(root)}`,
    );
  }

  const changed = await withWorkspaceMapLock(root, async () => {
    const transport = await loadTransport(root);
    await transport.pull();
    await writePublishedWorkspace(mapPaths(root).mapDir, config.definition!);
    return transport.push(`boot: save workspace ${config.definition!.workspace.id}`);
  });

  if (changed) logger.success(`Saved workspace ${colors.cyan(config.definition.workspace.id)}.`);
  else logger.info(colors.dim("The workspace is already saved."));
}
