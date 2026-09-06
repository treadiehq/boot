# Two agents in managed Boot workspaces

Run `pnpm demo:sessions` from the Boot repository with installed, authenticated
Codex and Claude CLIs. The demo consumes their existing authentication implicitly;
it never reads or copies credential files. This is a live model run and may incur
usage charges.

The script creates a disposable committed repository and two APFS/CoW sessions,
then launches both CLIs directly through `runSession`. Each agent edits a file
and records its cwd and Git root. Assertions check exact roots, unchanged worktree
registrations, independent source contents, exit results, and GC protection.

Codex uses `exec --ephemeral --sandbox workspace-write -- <prompt>`. Claude uses
`--print --no-session-persistence --permission-mode acceptEdits` and a narrow
allowed-tool list followed by `-- <prompt>`. It omits Claude's opt-in worktree
flag. These are direct CLI runs; desktop/cloud harnesses have separate policies.
See the primary references in [agent workflows](../../docs/agents.md).

On success the script writes
[`docs/session-agent-demo-results.json`](../../docs/session-agent-demo-results.json),
then releases and explicitly discards its own disposable sessions. A failed run
leaves an attempt journal and its work for inspection; rerunning recovers it only
after Boot verifies the processes have stopped. It never merges or publishes.
