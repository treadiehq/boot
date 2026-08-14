import { fileURLToPath } from "node:url";
import { Template } from "e2b";
import packageJson from "../../../package.json" with { type: "json" };

const canonicalSkill = fileURLToPath(
  new URL("../../../.agents/skills/boot-workspace/SKILL.md", import.meta.url),
);
const installedSkill = "/opt/boot-agent-skills/boot-workspace";
const bootVersion = `v${packageJson.version}`;

/**
 * E2B image definition only. Workspace realization intentionally happens in
 * launch.ts after Sandbox.create(), not as a template start command.
 */
export const template = Template()
  .fromUbuntuImage("24.04")
  .aptInstall([
    "ca-certificates",
    "curl",
    "git",
    "jq",
    "openssh-client",
    "ripgrep",
  ])
  .runCmd(
    `curl -fsSL https://useboot.co/install.sh | BOOT_VERSION=${bootVersion} BOOT_BIN_DIR=/usr/local/bin bash`,
  )
  .runCmd("boot --version")
  .makeDir(installedSkill, { mode: 0o755 })
  .copy(canonicalSkill, `${installedSkill}/SKILL.md`, { mode: 0o644 })
  .runCmd(
    "install -d -m 0755 -o user -g user /home/user/.agents/skills /home/user/.claude/skills",
  )
  .makeSymlink(installedSkill, "/home/user/.agents/skills/boot-workspace")
  .makeSymlink(installedSkill, "/home/user/.claude/skills/boot-workspace")
  .setUser("user")
  .setWorkdir("/home/user");
