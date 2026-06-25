import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Root directory for boot's machine-global state (the machine identity lives
 * here). Overridable via `BOOT_HOME`, which keeps tests hermetic and lets a
 * single process act as several "machines".
 */
export function stateDir(): string {
  return process.env.BOOT_HOME ?? path.join(os.homedir(), ".boot");
}

export const machineIdentitySchema = z.object({
  machineId: z.string(),
  hostname: z.string(),
  createdAt: z.string(),
});

export type MachineIdentity = z.infer<typeof machineIdentitySchema>;

function identityPath(): string {
  return path.join(stateDir(), "machine.json");
}

/**
 * Load this machine's stable identity, generating and persisting one on first
 * use. The identity is what lets each machine own its own slice of the shared
 * map (`machines/<id>.json`) without ever conflicting with another machine.
 */
export async function loadMachineIdentity(): Promise<MachineIdentity> {
  const file = identityPath();

  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = machineIdentitySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // No identity yet (or it is unreadable/corrupt) — fall through and create one.
  }

  const identity: MachineIdentity = {
    machineId: randomUUID(),
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}
