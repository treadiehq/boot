import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCommitAll } from "../core/git";

function gitUsable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const GIT_OK = gitUsable();
let root: string;
let repo: string;
let previousGlobalConfig: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-git-commit-"));
  repo = path.join(root, "map");
  const globalConfig = path.join(root, "gitconfig");
  await fs.mkdir(repo);
  await fs.writeFile(globalConfig, "");
  execFileSync("git", ["config", "--file", globalConfig, "commit.gpgSign", "true"]);
  execFileSync("git", [
    "config",
    "--file",
    globalConfig,
    "gpg.program",
    path.join(root, "missing-gpg"),
  ]);
  previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
});

afterEach(async () => {
  if (previousGlobalConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!GIT_OK)("gitCommitAll", () => {
  it("creates bookkeeping commits when global GPG signing is enabled", async () => {
    await fs.writeFile(path.join(repo, "map.json"), "{}\n");

    await expect(gitCommitAll(repo, "Update workspace map")).resolves.toBe(true);

    const identity = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(identity).toBe("boot <boot@localhost>");
  });
});
