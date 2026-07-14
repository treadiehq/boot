import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { statusCommand } from "../commands/status";
import { buildPlaceholderMeta, writePlaceholder } from "../core/placeholder";

let root: string;
let logs: string[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boot-status-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg ?? ""));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function makeHydrated(rel: string): Promise<void> {
  // A real git repo (fake .git) that also carries placeholder metadata.
  const repoDir = path.join(root, rel);
  await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
  await writePlaceholder(
    repoDir,
    buildPlaceholderMeta(
      { name: path.basename(rel), relativePath: rel, remoteUrl: "git@x:y.git", currentBranch: null, lastCommit: null },
      "hydrated",
    ),
  );
}

async function makePlaceholder(rel: string, remoteUrl: string | null): Promise<void> {
  const repoDir = path.join(root, rel);
  await fs.mkdir(repoDir, { recursive: true });
  await writePlaceholder(
    repoDir,
    buildPlaceholderMeta({
      name: path.basename(rel),
      relativePath: rel,
      remoteUrl,
      currentBranch: "main",
      lastCommit: "abc123",
    }),
  );
}

describe("statusCommand", () => {
  it("classifies hydrated repos, placeholders, and other folders", async () => {
    await makeHydrated("apps/kplane");
    await makePlaceholder("experiments/receipts", "git@github.com:dantelex2/receipts.git");
    await makePlaceholder("old/local-tool", null);
    await fs.mkdir(path.join(root, "scratch"), { recursive: true });
    await fs.writeFile(path.join(root, "notes.txt"), "x"); // a file, not a folder

    await statusCommand(root);
    const out = logs.join("\n");

    expect(out).toBe(`boot status
Cloned repositories:
✓ apps/kplane           (detached)  clean
Repository placeholders:
○ experiments/receipts  main       not cloned
○ old/local-tool        no remote  cannot clone: no remote
Other folders:
- scratch
Summary:
Cloned repositories: 1
Repository placeholders: 2
Dirty repositories: 0
Other folders: 1`);
  });
});
