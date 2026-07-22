# Agent workflows

Every agent integration follows the same contract:

1. Prepare the selected workspace profile.
2. Run `boot inspect --json`.
3. Read repository roles, paths, commands, requirements, and constraints.
4. Work only within repositories selected by the active profile.
5. Use the declared commands instead of inventing project workflows.

## Claude Code

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

## Fresh cloud environments

When the workspace has been published through a workspace map:

```bash
boot agent git@github.com:acme/billing-map.git /workspace \
  --profile agent --run-setup --json
```

`boot agent` is the one-shot bootstrap contract for CI, cloud VMs, and fresh
containers. On the first run it links the published map; later runs pull and
reapply it safely. It uses the published `agent` profile by default when one
exists, or accepts another profile with `--profile`.

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
no matching secret key. Setup commands execute only with `--run-setup`.

The older `--hydrate`, `--all`, and `--eager` map flags remain available for
maps that do not yet publish `boot.yaml`.

Automation should check the exit status of `boot agent` or `boot up`. Partial
repository, service, tool, setup, or environment failures produce a nonzero
exit.
