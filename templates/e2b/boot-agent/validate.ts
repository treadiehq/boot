import {
  lstat,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const canonicalSkill = path.join(
  root,
  ".agents",
  "skills",
  "boot-workspace",
  "SKILL.md",
);
const claudeSkill = path.join(
  root,
  ".claude",
  "skills",
  "boot-workspace",
);
const templateDirectory = path.join(root, "templates", "e2b", "boot-agent");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const skill = await readFile(canonicalSkill, "utf8");
  assert(
    /^---\nname: boot-workspace\ndescription: .+\ncompatibility: .+\n---\n/.test(
      skill,
    ),
    "The canonical SKILL.md does not use valid portable frontmatter.",
  );
  for (const required of [
    "boot inspect --json",
    "repositories",
    "workspace.readOnly",
    "commands",
    "constraints",
    "Never request, print, copy, infer, summarize, or persist secret values",
  ]) {
    assert(skill.includes(required), `SKILL.md is missing: ${required}`);
  }

  const claudeStat = await lstat(claudeSkill);
  assert(
    claudeStat.isSymbolicLink(),
    ".claude/skills/boot-workspace must be a symlink.",
  );
  assert(
    (await realpath(claudeSkill)) === path.dirname(canonicalSkill),
    "Claude and Codex must resolve to the same skill directory.",
  );
  assert(
    (await readlink(claudeSkill)) ===
      "../../.agents/skills/boot-workspace",
    "The Claude skill symlink must remain repository-relative.",
  );

  const templateSource = await readFile(
    path.join(templateDirectory, "template.ts"),
    "utf8",
  );
  for (const systemPackage of [
    '"curl"',
    '"git"',
    '"jq"',
    '"openssh-client"',
    '"ripgrep"',
  ]) {
    assert(
      templateSource.includes(systemPackage),
      `The E2B template is missing ${systemPackage}.`,
    );
  }
  assert(
    !templateSource.includes(".setStartCmd("),
    "Boot must not be configured as an E2B build start command.",
  );
  assert(
    templateSource.includes(
      "../../../.agents/skills/boot-workspace/SKILL.md",
    ),
    "The E2B template must copy the canonical skill.",
  );

  const launchSource = await readFile(
    path.join(templateDirectory, "launch.ts"),
    "utf8",
  );
  const createIndex = launchSource.indexOf("Sandbox.create(");
  const bootIndex = launchSource.indexOf("https://useboot.co/agent.sh");
  assert(createIndex >= 0, "The launch script must create an E2B sandbox.");
  assert(
    bootIndex > createIndex,
    "The launch script must run Boot synchronously after sandbox creation.",
  );
  assert(
    launchSource.includes('options+=(--map-commit "$BOOT_MAP_COMMIT")'),
    "The launch script must support exact map commit pinning.",
  );
  assert(
    launchSource.includes("boot inspect --json"),
    "The launch script must inspect the realized workspace.",
  );

  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as {
    devDependencies?: Record<string, string>;
  };
  assert(
    typeof packageJson.devDependencies?.e2b === "string",
    "The root package must declare the E2B SDK.",
  );

  for (const script of ["build.ts", "launch.ts", "smoke.ts"]) {
    await lstat(path.join(templateDirectory, script));
  }

  process.stdout.write("Boot Agent Skill and E2B template validation passed.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Validation failed: ${message}\n`);
  process.exitCode = 1;
});
