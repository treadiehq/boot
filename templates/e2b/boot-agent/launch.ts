import { readFile } from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "e2b";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function timeoutFromEnvironment(): number {
  const raw = optionalEnvironment("E2B_TIMEOUT_MS");
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const timeout = Number(raw);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("E2B_TIMEOUT_MS must be a positive integer in milliseconds.");
  }
  return timeout;
}

function assertSafeMapReference(remote: string): void {
  if (/[\r\n\0]/.test(remote)) {
    throw new Error("BOOT_MAP must be a single-line remote or folder reference.");
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) {
      throw new Error(
        "BOOT_MAP must not contain credentials. Use runtime SSH credential files instead.",
      );
    }
  }
}

async function uploadCredentialFile(
  sandbox: Sandbox,
  localPath: string | undefined,
  remotePath: string,
): Promise<void> {
  if (!localPath) return;
  const contents = await readFile(localPath, "utf8");
  await sandbox.files.write(remotePath, contents);
}

function parseJson(label: string, value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function requireReadyBootstrap(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { ready?: unknown }).ready !== true
  ) {
    throw new Error("boot agent did not report a ready workspace.");
  }
  return value as Record<string, unknown>;
}

function requireReadyInspection(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("boot inspect did not return an object.");
  }
  const inspection = value as {
    workspace?: { ready?: unknown };
    blockers?: unknown;
  };
  if (
    inspection.workspace?.ready !== true ||
    !Array.isArray(inspection.blockers) ||
    inspection.blockers.length > 0
  ) {
    throw new Error("boot inspect reported unresolved workspace blockers.");
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  requiredEnvironment("E2B_API_KEY");
  const map = requiredEnvironment("BOOT_MAP");
  assertSafeMapReference(map);

  const templateName = optionalEnvironment("E2B_TEMPLATE") ?? "boot-agent";
  const workspace = optionalEnvironment("BOOT_WORKSPACE") ?? "/home/user/workspace";
  const profile = optionalEnvironment("BOOT_PROFILE") ?? "agent";
  const mapCommit = optionalEnvironment("BOOT_MAP_COMMIT") ?? "";
  const timeoutMs = timeoutFromEnvironment();

  if (!path.posix.isAbsolute(workspace)) {
    throw new Error("BOOT_WORKSPACE must be an absolute sandbox path.");
  }
  if (/[\r\n\0]/.test(workspace) || /[\r\n\0]/.test(profile)) {
    throw new Error("BOOT_WORKSPACE and BOOT_PROFILE must be single-line values.");
  }
  if (
    mapCommit &&
    !/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(mapCommit)
  ) {
    throw new Error("BOOT_MAP_COMMIT must be a full 40- or 64-character hexadecimal SHA.");
  }

  const sandbox = await Sandbox.create(templateName, { timeoutMs });
  let ready = false;

  try {
    const sshKey = optionalEnvironment("BOOT_SSH_PRIVATE_KEY_FILE");
    const knownHosts = optionalEnvironment("BOOT_SSH_KNOWN_HOSTS_FILE");
    if (sshKey && !knownHosts) {
      throw new Error(
        "BOOT_SSH_KNOWN_HOSTS_FILE is required with BOOT_SSH_PRIVATE_KEY_FILE.",
      );
    }

    if (sshKey) {
      await sandbox.commands.run(
        "install -d -m 0700 /home/user/.ssh",
        { timeoutMs },
      );
      await uploadCredentialFile(
        sandbox,
        sshKey,
        "/home/user/.ssh/id_ed25519",
      );
      await uploadCredentialFile(
        sandbox,
        knownHosts,
        "/home/user/.ssh/known_hosts",
      );
      await sandbox.commands.run(
        "chmod 0600 /home/user/.ssh/id_ed25519 /home/user/.ssh/known_hosts",
        { timeoutMs },
      );
    }

    const bootKey = optionalEnvironment("BOOT_SECRET_KEY_FILE");
    if (bootKey) {
      await sandbox.commands.run(
        "install -d -m 0700 /home/user/.boot",
        { timeoutMs },
      );
      await uploadCredentialFile(
        sandbox,
        bootKey,
        "/home/user/.boot/secret.key",
      );
      await sandbox.commands.run(
        "chmod 0600 /home/user/.boot/secret.key",
        { timeoutMs },
      );
    }

    const bootstrapCommand = [
      "set -euo pipefail",
      'options=(--profile "$BOOT_PROFILE")',
      '[[ "$BOOT_NO_ENV" != "1" ]] || options+=(--no-env)',
      '[[ -z "$BOOT_MAP_COMMIT" ]] || options+=(--map-commit "$BOOT_MAP_COMMIT")',
      'curl -fsSL https://useboot.co/agent.sh | bash -s -- "$BOOT_MAP" "$BOOT_WORKSPACE" "${options[@]}"',
    ].join("\n");
    const bootstrap = await sandbox.commands.run(
      bootstrapCommand,
      {
        envs: {
          BOOT_MAP: map,
          BOOT_WORKSPACE: workspace,
          BOOT_PROFILE: profile,
          BOOT_MAP_COMMIT: mapCommit,
          BOOT_NO_ENV: process.env.BOOT_NO_ENV === "1" ? "1" : "0",
        },
        timeoutMs,
      },
    );

    const inspection = await sandbox.commands.run(
      'cd "$BOOT_WORKSPACE" && boot inspect --json',
      {
        envs: { BOOT_WORKSPACE: workspace },
        timeoutMs,
      },
    );

    const bootstrapOutput = requireReadyBootstrap(
      parseJson("boot agent", bootstrap.stdout),
    );
    const inspectionOutput = requireReadyInspection(
      parseJson("boot inspect", inspection.stdout),
    );
    ready = true;
    process.stdout.write(
      `${JSON.stringify(
        {
          sandboxId: sandbox.sandboxId,
          workspace,
          bootstrap: bootstrapOutput,
          inspection: inspectionOutput,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (!ready) {
      await sandbox.kill().catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`E2B launch failed: ${message}\n`);
  process.exitCode = 1;
});
