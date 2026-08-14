import { Sandbox } from "e2b";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  requiredEnvironment("E2B_API_KEY");
  const templateName = process.env.E2B_TEMPLATE?.trim() || "boot-agent";
  const sandbox = await Sandbox.create(templateName, { timeoutMs: 5 * 60 * 1000 });

  try {
    const result = await sandbox.commands.run(
      [
        "set -eu",
        "for command in git curl jq ssh rg boot; do command -v \"$command\" >/dev/null; done",
        "test -r /opt/boot-agent-skills/boot-workspace/SKILL.md",
        "test -L /home/user/.agents/skills/boot-workspace",
        "test -L /home/user/.claude/skills/boot-workspace",
        "cmp /home/user/.agents/skills/boot-workspace/SKILL.md /home/user/.claude/skills/boot-workspace/SKILL.md",
        "boot --version >/dev/null",
        "printf 'boot-agent template smoke check passed\\n'",
      ].join("\n"),
      { timeoutMs: 60_000 },
    );
    process.stdout.write(result.stdout);
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`E2B smoke check failed: ${message}\n`);
  process.exitCode = 1;
});
