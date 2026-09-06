# Agent workflows

Every agent integration follows the same contract:

1. Prepare the selected workspace profile.
2. Run `boot inspect --json`.
3. Read repository roles, paths, commands, requirements, and constraints.
4. Work only within repositories selected by the active profile.
5. Use the declared commands instead of inventing project workflows.

## Claude Code

For a managed task workspace:

```bash
boot session create . --profile agent --name claude-fix --storage auto
boot session run claude-fix -- claude
```

Launch the CLI directly and omit its opt-in `--worktree` / `-w` flag. Claude's
desktop worktree behavior is separate. Boot cannot prevent a tool or agent from
explicitly creating another checkout. See the official
[CLI reference](https://code.claude.com/docs/en/cli-reference) and
[worktree documentation](https://code.claude.com/docs/en/worktrees).

For preparation in an existing workspace:

```bash
boot up /workspace --profile agent
boot inspect /workspace --json > /tmp/boot-context.json
cd /workspace
claude
```

Suggested `CLAUDE.md`:

```markdown
Before working, run `boot inspect --json`.
Treat its active profile as the allowed workspace scope.
Follow repository roles, commands, environment status, and constraints.
Never request or print secret values; availability is sufficient.
```

## OpenCode

```bash
boot up ~/code --profile agent
cd ~/code
opencode
```

Add to project instructions:

```markdown
Use `boot inspect --json` as the source of truth for this workspace.
Do not infer missing repositories by crawling outside the reported root.
Use commands declared in the Boot context.
```

## Codex

For a managed task workspace:

```bash
boot session create . --profile agent --name codex-fix --storage auto
boot session run codex-fix -- codex
# A noninteractive run uses the same root:
boot session run codex-fix -- codex exec --sandbox workspace-write -- "Implement the task"
```

Boot sets cwd to the managed root. Codex CLI accepts that directory as its
workspace; omit `--cd` unless intentionally selecting a directory inside it.
This is the direct CLI launch path documented in the
[Codex CLI reference](https://developers.openai.com/codex/cli/reference/).
Desktop/cloud task creation can have its own checkout policy.

For preparation without a managed session:

```bash
boot up /workspace --profile agent --provider local
boot inspect /workspace --json
codex
```

Suggested `AGENTS.md`:

```markdown
## Workspace

At the beginning of a task, run `boot inspect --json`.

- Modify only repositories included in the active Boot profile.
- Use repository roles to locate the correct implementation.
- Use declared setup, test, and development commands.
- Treat Boot constraints as task instructions.
- Do not print, copy, or infer secret values.
```

## Session ownership and results

Use `boot session inspect <name> --json` and `boot session diff <name>` to review
the result, then `release` and preview `gc`. GC preserves new commits even after
an external push/merge until the operator explicitly discards that exact session.
For externally launched editors, claim with `boot session claim <name> --owner
editor` before launch and release with the same label after stopping it.

The [two-agent example](../examples/agent-sessions/README.md) runs installed Codex
and Claude against disposable repositories and checks their actual cwd/Git roots,
checkout registrations, source isolation, and cleanup protection. The
[session guide](sessions.md) explains snapshots, encrypted environment delivery,
process groups, and the distinction between read-only intent and OS enforcement.

## Portable Boot workspace skill

This repository ships one
[Agent Skills](https://agentskills.io) artifact at
`.agents/skills/boot-workspace/SKILL.md`. Codex discovers that canonical path,
and Claude Code discovers the same artifact through the repository-relative
`.claude/skills/boot-workspace` symlink. The skill requires
`boot inspect --json` before project work and treats reported repository scope,
read-only intent, commands, and constraints as mandatory while prohibiting
secret access or disclosure.

## Fresh cloud environments

When the workspace has been published through a workspace map:

```bash
curl -fsSL https://useboot.co/agent.sh | bash -s -- \
  git@github.com:acme/billing-map.git /workspace --profile agent
```

The adapter installs Boot when needed and invokes `boot agent` with
`--run-setup --ephemeral --json`. Ephemeral mode still prepares the target
workspace, but it never creates or publishes machine identity/state. `boot
agent` remains the one-shot bootstrap contract for CI, cloud VMs, and fresh
containers. On the first run it links the published map; later runs pull and
reapply it safely. It uses the published `agent` profile by default when one
exists, or accepts another profile with `--profile`.

For an immutable map input, append `--map-commit <full-sha>`. Real pinned runs
must be ephemeral; pinned dry runs are also supported. The result reports the
exact consumed commit and whether it was pinned.

The JSON result includes:

- source kind and whether it was linked, updated, cached, or previewed;
- the resolved workspace, profile, and provider;
- repository actions and states;
- required and observed tool/service status;
- environment names and availability, never values;
- selected commands, constraints, blockers, applied actions, and failures.

Use `--dry-run --json` to preview without changing the target. Environment
materialization is enabled for a published workspace unless `--no-env` is
passed. Required Boot-managed values make readiness fail when the machine has
no matching secret key. Setup commands execute only with `--run-setup`, and
service start commands only with `--start`.

The older `--hydrate`, `--all`, and `--eager` map flags remain available for
maps that do not yet publish `boot.yaml`.

Automation should check the exit status of `boot agent` or `boot up`. Partial
repository, service, tool, setup, or environment failures produce a nonzero
exit.

For a current E2B code-defined image and runtime launcher, see
[`templates/e2b/boot-agent`](../templates/e2b/boot-agent/README.md). The image
contains the canonical skill at both Codex and Claude discovery locations, but
runs Boot synchronously only after `Sandbox.create()` receives a credential-free
`BOOT_MAP` reference.
