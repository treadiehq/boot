import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify } from "yaml";
import { requireGit } from "../core/sessionStorage";

export async function sessionFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.BOOT_TEST_WORKSPACE_ROOT ?? os.tmpdir(), "boot-session-case-")));
  const source = path.join(root, "source"), store = path.join(root, "store"), home = path.join(root, "home");
  await fs.mkdir(source);
  await requireGit(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, ".gitignore"), ".boot/\nnode_modules/\n");
  await fs.writeFile(path.join(source, "file.txt"), "original\n");
  await fs.writeFile(path.join(source, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "fixture", name: "Fixture" }, repositories: { app: { path: "." } }, profiles: { agent: { repositories: "all" } } }));
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  return { root, source, store, home };
}
