import os from "node:os";
import { Command, Option } from "commander";
import { createSession, claimSession, gcSessions, inspectSession, releaseSession, sessionDiff } from "../core/sessions";
import { listSessionRecords } from "../core/sessionStore";
import { runSession } from "../core/sessionRun";
import { logger } from "../ui/logger";

function print(value: unknown) { logger.info(JSON.stringify(value, null, 2)); }

export function addSessionCommands(program: Command): void {
  const session = program.command("session").description("create, run, inspect, and reclaim managed agent workspaces");
  session.command("create").argument("<workspace>")
    .option("--profile <profile>", "profile to snapshot (agent when present, otherwise the workspace default)")
    .option("--name <name>", "unique session name within its store")
    .addOption(new Option("--storage <backend>", "requested storage backend").choices(["auto", "cow", "worktree", "clone"]).default("auto"))
    .option("--store <path>", "session store (default: <workspace>/.boot/sessions)")
    .option("--runtime", "provision profile-selected application ports and disposable PostgreSQL databases", false)
    .option("--include-working-tree", "capture staged, unstaged, and untracked source changes", false)
    .option("--include <paths...>", "prepared artifact paths relative to the workspace; requires CoW")
    .option("--json", "write JSON", false)
    .action(async (workspace, options) => {
      const record = await createSession(workspace, options);
      if (options.json) print(record);
      else {
        logger.info(`Created ${record.name} (${record.id})\n${record.root}`);
        for (const repo of record.repositories) {
          logger.info(`${repo.id}: ${repo.backend}${repo.fallbackReason ? ` — ${repo.fallbackReason}` : ""}`);
          if (repo.excludedChanges.length) logger.info(`Excluded source changes: ${JSON.stringify(repo.excludedChanges)}`);
        }
      }
    });
  session.command("run").argument("<session>").argument("[agentArgs...]")
    .description("launch an executable directly: boot session run <session> -- <command> [args...]")
    .option("--store <path>")
    .action(async (selector, agentArgs: string[], options) => {
      const exit = await runSession(selector, agentArgs, options);
      process.exitCode = exit.code ?? (exit.signal ? 128 + os.constants.signals[exit.signal] : 1);
      // Re-raise the child's signal after state has been saved and forwarding
      // handlers removed, preserving shell-visible termination semantics.
      if (exit.signal && process.platform !== "win32") process.kill(process.pid, exit.signal);
    });
  session.command("list").option("--store <path>").option("--json", "write JSON", false)
    .action(async (options) => {
      const records = await listSessionRecords(options.store);
      const inspections = [];
      for (const record of records) inspections.push(await inspectSession(record.id, record.store));
      if (options.json) print({ schemaVersion: 1, sessions: inspections });
      else for (const item of inspections) logger.info(`${item.session.id}  ${item.session.name}  ${item.session.state}  ${item.eligible ? "eligible for GC" : item.protection.join("; ")}`);
    });
  session.command("inspect").argument("<session>").option("--store <path>").option("--json", "write JSON", false)
    .action(async (selector, options) => { print(await inspectSession(selector, options.store)); });
  session.command("diff").argument("<session>").option("--store <path>")
    .action(async (selector, options) => { logger.info(await sessionDiff(selector, options.store)); });
  session.command("release").argument("<session>").option("--store <path>")
    .option("--owner <label>", "acknowledge that the external agent with this exact owner label has stopped")
    .option("--acknowledge-stopped", "acknowledge that an interrupted launcher and all descendants have stopped", false)
    .action(async (selector, options) => { const record = await releaseSession(selector, options); logger.info(`Released ${record.name} (${record.id}); files and database data retained.`); });
  session.command("claim").argument("<session>").requiredOption("--owner <label>", "nonsecret external agent identifier").option("--store <path>")
    .description("protect a workspace while an externally launched agent uses it")
    .action(async (selector, options) => { print(await claimSession(selector, options.owner, options.store)); });
  session.command("gc").option("--store <path>").option("--apply", "apply cleanup; otherwise preview only", false)
    .option("--session <id>", "inspect or clean only one session")
    .option("--discard-work <id>", "discard work only for the same full session ID selected by --session")
    .option("--json", "write JSON", false)
    .action(async (options) => { print(await gcSessions(options)); });
  const examples: Record<string, string> = {
    create: "boot session create . --profile agent --name fix --storage auto",
    run: "boot session run fix -- codex", list: "boot session list --json",
    inspect: "boot session inspect fix --json", diff: "boot session diff fix",
    release: "boot session release fix", claim: "boot session claim fix --owner editor",
    gc: "boot session gc --apply",
  };
  for (const command of session.commands) command.addHelpText("after", `\nExamples:\n  ${examples[command.name()]}\n`);
}
