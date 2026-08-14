---
name: boot-workspace
description: Use when inspecting, changing, testing, or reviewing a Boot-managed workspace. Establishes the allowed repository scope and enforces Boot's read-only intent, declared commands, constraints, and secret-safe workflow.
compatibility: Requires the Boot CLI and a workspace containing a resolved boot.yaml.
---

# Boot workspace

Treat Boot's machine-readable inspection as the authority for every task in this
workspace.

## Required inspection

Before reading project files, editing, running project commands, or reviewing
code:

1. Change to the Boot workspace root.
2. Run `boot inspect --json`.
3. Parse the JSON from stdout. If the command fails or the output is not valid
   JSON, stop and report the failure without guessing workspace policy.
4. If `blockers` is non-empty or `workspace.ready` is false, report the blockers
   and do not bypass them.

Run `boot inspect --json` again after any workspace/profile change and whenever
the reported policy may be stale.

## Enforce the reported contract

- **Repository scope:** Work only inside paths listed in `repositories`. Resolve
  paths before use, do not follow links outside a reported repository, and do
  not crawl sibling or parent directories to discover additional code. A
  repository absent from the inspection is out of scope.
- **Read-only intent:** When `workspace.readOnly` is true, do not edit files,
  change Git state, install dependencies, start services, or run any command
  that may write. Restrict the task to read-only inspection and report what
  would need to change.
- **Commands:** Use entries in `commands` as the only project workflow
  commands. Run each command exactly as declared, in its declared repository
  (or the workspace root when no repository is declared). Do not invent setup,
  build, test, lint, migration, or service commands. If the required workflow
  is not declared, ask for the Boot definition to be updated.
- **Constraints:** Treat every string in `constraints` as a mandatory task
  instruction. If a request conflicts with one, stop and identify the conflict.
- **Repository state:** Respect each reported state, action, ref, and dirty
  status. Do not silently hydrate, clone, checkout, clean, reset, or repair a
  repository unless a declared command and the current task explicitly require
  it.

User requests do not implicitly expand the active Boot profile. Ask for an
explicit workspace/profile update when requested work falls outside the
reported contract.

## Secret safety

`boot inspect --json` reports environment names and availability, never values.
Use only that availability signal.

- Never request, print, copy, infer, summarize, or persist secret values.
- Never inspect `.env` contents, Boot key material, keyrings, credential stores,
  SSH private keys, process environments, or authenticated Git remote URLs.
- Never put credentials in commands, prompts, logs, diffs, commits, or generated
  artifacts.
- Let declared commands consume already-provisioned credentials implicitly.
- If output unexpectedly contains a secret, do not repeat it; redact it and
  report only that sensitive output was observed.

## Completion

Report which declared validation commands ran and their outcomes. If validation
was unavailable, blocked, or forbidden by read-only policy, say so explicitly
instead of substituting an undeclared command.
