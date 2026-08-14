import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = path.resolve(process.cwd(), "scripts", "agent.sh");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "boot-agent-script-"));
  roots.push(root);
  return root;
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o755 });
}

function runScript(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("agent.sh", () => {
  it("fails fast with a copy-pasteable invocation when arguments are missing", () => {
    const result = runScript([]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Usage: agent.sh <workspace-map> <workspace-path> [boot agent options]",
    );
    expect(result.stderr).toContain("https://useboot.co/agent.sh");
  });

  it("uses an existing Boot binary and forwards the one-shot agent contract", () => {
    const root = tempRoot();
    const binDir = path.join(root, "bin");
    const callLog = path.join(root, "args.txt");
    const workspace = path.join(root, "workspace with spaces");
    mkdirSync(binDir);
    writeExecutable(
      path.join(binDir, "boot"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'test-version\\n'
  exit 0
fi
printf '%s\\n' "$@" > "$BOOT_TEST_LOG"
printf '{"ready":true}\\n'
`,
    );

    const result = runScript(
      ["git@github.com:acme/map.git", workspace, "--profile", "agent", "--no-env"],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        BOOT_TEST_LOG: callLog,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ready":true}\n');
    expect(result.stderr).toBe("");
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      "agent",
      "git@github.com:acme/map.git",
      workspace,
      "--profile",
      "agent",
      "--no-env",
      "--run-setup",
      "--json",
    ]);
  });

  it("installs Boot when needed without contaminating JSON stdout", () => {
    const root = tempRoot();
    const binDir = path.join(root, "installed");
    const callLog = path.join(root, "installed-args.txt");
    const installer = path.join(root, "install.sh");
    writeExecutable(
      installer,
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$BOOT_BIN_DIR"
cat > "$BOOT_BIN_DIR/boot" <<'BOOT'
#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'installed-version\\n'
  exit 0
fi
printf '%s\\n' "$@" > "$BOOT_TEST_LOG"
printf '{"ready":true,"installed":true}\\n'
BOOT
chmod +x "$BOOT_BIN_DIR/boot"
printf 'fixture installer output\\n'
`,
    );

    const result = runScript(
      ["https://github.com/acme/map.git", path.join(root, "workspace"), "--json"],
      {
        BOOT_BIN_DIR: binDir,
        BOOT_FORCE_INSTALL: "1",
        BOOT_INSTALL_URL: pathToFileURL(installer).href,
        BOOT_TEST_LOG: callLog,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ready":true,"installed":true}\n');
    expect(result.stderr).toContain("Installing Boot from file:");
    expect(result.stderr).toContain("fixture installer output");
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      "agent",
      "https://github.com/acme/map.git",
      path.join(root, "workspace"),
      "--json",
      "--run-setup",
    ]);
  });

  it("does not duplicate explicit output or setup flags", () => {
    const root = tempRoot();
    const binDir = path.join(root, "bin");
    const callLog = path.join(root, "args.txt");
    mkdirSync(binDir);
    writeExecutable(
      path.join(binDir, "boot"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then exit 0; fi
printf '%s\\n' "$@" > "$BOOT_TEST_LOG"
printf '{}\\n'
`,
    );

    const result = runScript(
      [
        "git@github.com:acme/map.git",
        path.join(root, "workspace"),
        "--run-setup",
        "--json",
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        BOOT_TEST_LOG: callLog,
      },
    );

    expect(result.status).toBe(0);
    const args = readFileSync(callLog, "utf8").trim().split("\n");
    expect(args.filter((arg) => arg === "--run-setup")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--json")).toHaveLength(1);
  });
});
