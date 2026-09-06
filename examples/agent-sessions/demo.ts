import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { execa } from "execa";
import { createSession, inspectSession, releaseSession, gcSessions } from "../../src/core/sessions";
import { runSession } from "../../src/core/sessionRun";
import { requireGit } from "../../src/core/sessionStorage";
import { listSessionRecords } from "../../src/core/sessionStore";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const attemptFile = path.join(repoRoot, "docs", "session-agent-demo-attempt.json");
const previous = await fs.readFile(attemptFile, "utf8").then(JSON.parse, (error) => { if (error.code === "ENOENT") return null; throw error; });
if (previous) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  if (path.dirname(previous.root) !== temporaryRoot || !path.basename(previous.root).startsWith("boot-two-agents-")) throw new Error("Unexpected previous demo path; retain it for manual inspection.");
  const previousStore = path.join(previous.root, "store");
  for (const session of await listSessionRecords(previousStore)) {
    await releaseSession(session.id, { store: previousStore, acknowledgeStopped: true });
    await gcSessions({ store: previousStore, session: session.id, discardWork: session.id, apply: true });
  }
  await fs.rm(previous.root, { recursive: true });
  await fs.rm(attemptFile);
}
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "boot-two-agents-")));
await fs.writeFile(attemptFile, JSON.stringify({ root }));
const source = path.join(root, "source"), store = path.join(root, "store");
const priorBootHome = process.env.BOOT_HOME;
process.env.BOOT_HOME = path.join(root, "home");
try {
  await fs.mkdir(source);
  await requireGit(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "boot.yaml"), stringify({ schemaVersion: 1, workspace: { id: "two-agents", name: "Two agents" }, repositories: { demo: { path: "." } }, commands: { test: "node --test" }, profiles: { agent: { repositories: "all" } } }));
  await fs.writeFile(path.join(source, ".gitignore"), ".boot/\n");
  await fs.writeFile(path.join(source, "message.txt"), "original\n");
  await requireGit(source, ["add", "."]);
  await requireGit(source, ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "demo base"]);
  const agents = [
    { name: "codex", args: ["exec", "--ephemeral", "--sandbox", "workspace-write"] },
    { name: "claude", args: ["--print", "--no-session-persistence", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Bash(pwd),Bash(git rev-parse *),Bash(git worktree list *)"] },
  ];
  const sessions = [];
  for (const agent of agents) sessions.push(await createSession(source, { name: agent.name, store, storage: "cow" }));
  const outcomes = await Promise.allSettled(agents.map(async (agent, index) => {
    const session = sessions[index]!;
    const version = (await execa(agent.name, ["--version"])).stdout;
    const prompt = `This is a disposable Boot integration demo. Stay in the current working directory. Do not create another checkout, worktree, agent, or task. Do not access credentials, network tools, or files outside this directory. Change message.txt to exactly '${agent.name} ran in Boot' followed by a newline. Create proof.json containing the absolute current working directory under key cwd and the current Git working-tree root under key gitRoot (use pwd and git rev-parse --show-toplevel). Do not commit or publish. Then stop.`;
    console.log(`Launching ${version} in ${session.root}`);
    const before = await requireGit(session.root, ["worktree", "list", "--porcelain"]);
    const exit = await runSession(session.id, [agent.name, ...agent.args, "--", prompt], { store });
    if (exit.code !== 0) throw new Error(`${agent.name} exited with ${exit.code ?? exit.signal}`);
    const after = await requireGit(session.root, ["worktree", "list", "--porcelain"]);
    const proof = JSON.parse(await fs.readFile(path.join(session.root, "proof.json"), "utf8"));
    if (exit.code !== 0 || before !== after || proof.cwd !== session.root || proof.gitRoot !== session.root) throw new Error(`${agent.name} did not demonstrate execution in the Boot workspace without another registered checkout.`);
    const message = await fs.readFile(path.join(session.root, "message.txt"), "utf8");
    if (message !== `${agent.name} ran in Boot\n`) throw new Error(`${agent.name} did not make its expected independent edit.`);
    await releaseSession(session.id, { store });
    const inspection = await inspectSession(session.id, store);
    if (inspection.eligible) throw new Error("GC failed to protect the agent's output.");
    return { agent: agent.name, version, exitCode: exit.code, backend: session.repositories[0]!.backend, rootVerified: true, worktreeRegistrationUnchanged: true, gcProtectedWork: true };
  }));
  const failure = outcomes.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const results = outcomes.map((result) => (result as PromiseFulfilledResult<unknown>).value);
  if (await fs.readFile(path.join(source, "message.txt"), "utf8") !== "original\n") throw new Error("Agent edits affected the source.");
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), results, sourceUnchanged: true };
  await fs.writeFile(path.join(repoRoot, "docs", "session-agent-demo-results.json"), JSON.stringify(report, null, 2) + "\n");
  // Only this demo's exact disposable sessions are discarded after verification.
  for (const session of sessions) await gcSessions({ store, session: session.id, discardWork: session.id, apply: true });
  console.log(JSON.stringify(report, null, 2));
  await fs.rm(root, { recursive: true });
  await fs.rm(attemptFile);
} finally {
  if (priorBootHome === undefined) delete process.env.BOOT_HOME; else process.env.BOOT_HOME = priorBootHome;
  // Leave failed demo output for inspection; never delete an active agent.
  console.log(`Demo workspace: ${root}`);
}
