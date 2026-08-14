import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = process.cwd();
const SKILL_DIRECTORY = path.join(
  ROOT,
  ".agents",
  "skills",
  "boot-workspace",
);
const SKILL = path.join(SKILL_DIRECTORY, "SKILL.md");
const CLAUDE_SKILL = path.join(
  ROOT,
  ".claude",
  "skills",
  "boot-workspace",
);
const TEMPLATE_DIRECTORY = path.join(
  ROOT,
  "templates",
  "e2b",
  "boot-agent",
);

describe.skipIf(process.platform === "win32")(
  "portable Boot Agent Skill",
  () => {
    it("uses portable Agent Skills frontmatter and enforces Boot policy", () => {
      const contents = readFileSync(SKILL, "utf8");
      const match = /^---\n([\s\S]+?)\n---\n/.exec(contents);

      expect(match).not.toBeNull();
      expect(parse(match![1])).toMatchObject({
        name: "boot-workspace",
        description: expect.any(String),
        compatibility: expect.any(String),
      });
      expect(contents).toContain("boot inspect --json");
      expect(contents).toContain("workspace.readOnly");
      expect(contents).toContain("paths listed in `repositories`");
      expect(contents).toContain("Use entries in `commands`");
      expect(contents).toContain("every string in `constraints`");
      expect(contents).toContain("Never request, print, copy, infer");
    });

    it("provides Claude and Codex the same canonical artifact", () => {
      expect(lstatSync(CLAUDE_SKILL).isSymbolicLink()).toBe(true);
      expect(readlinkSync(CLAUDE_SKILL)).toBe(
        "../../.agents/skills/boot-workspace",
      );
      expect(realpathSync(CLAUDE_SKILL)).toBe(realpathSync(SKILL_DIRECTORY));
    });
  },
);

describe("E2B Boot agent template", () => {
  it("installs required tools and has no build start command", () => {
    const contents = readFileSync(
      path.join(TEMPLATE_DIRECTORY, "template.ts"),
      "utf8",
    );

    for (const systemPackage of [
      "curl",
      "git",
      "jq",
      "openssh-client",
      "ripgrep",
    ]) {
      expect(contents).toContain(`"${systemPackage}"`);
    }
    expect(contents).toContain(
      "../../../.agents/skills/boot-workspace/SKILL.md",
    );
    expect(contents).not.toContain(".setStartCmd(");
  });

  it("runs the public Boot adapter synchronously after sandbox creation", () => {
    const contents = readFileSync(
      path.join(TEMPLATE_DIRECTORY, "launch.ts"),
      "utf8",
    );
    const createIndex = contents.indexOf("Sandbox.create(");
    const bootIndex = contents.indexOf("https://useboot.co/agent.sh");

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(bootIndex).toBeGreaterThan(createIndex);
    expect(contents).toContain('options+=(--map-commit "$BOOT_MAP_COMMIT")');
    expect(contents).toContain("requireReadyBootstrap");
    expect(contents).toContain("requireReadyInspection");
    expect(contents).toContain("boot inspect --json");
  });

  it("ships build, launch, smoke, and credential-free validation scripts", () => {
    for (const file of [
      "build.ts",
      "launch.ts",
      "smoke.ts",
      "validate.ts",
    ]) {
      expect(lstatSync(path.join(TEMPLATE_DIRECTORY, file)).isFile()).toBe(
        true,
      );
    }

    const packageJson = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.devDependencies?.e2b).toBeDefined();
  });
});
