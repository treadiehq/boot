# One workspace for local work, agents, and CI

Use one workspace definition for local development, an agent, and CI.

## Local OpenCode

```bash
boot up ~/undo-workspace --profile local
cd ~/undo-workspace
opencode
```

Repositories start as placeholders and clone when needed.

## Fresh coding-agent environment

```bash
boot up /workspace --profile agent
boot inspect /workspace --json
```

Only the core and benchmark repositories are selected. The `hydrate: eager`
setting clones both before `boot up` finishes.

## CI

```bash
boot up "$PWD" --profile ci --json
CONTEXT="$(boot inspect "$PWD" --profile ci --json)"
```

CI receives the same repository roles, constraints, and approved test and
benchmark commands as the local agent.

All three flows use the local provider. The workspace definition stays the same
while the selected profile changes. Future providers can prepare it in another
environment without changing the definition.

The URLs are illustrative and must be replaced before running the demo.
