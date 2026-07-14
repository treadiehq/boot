# Changelog

## 0.2.7 - 2026-07-14

### Workspace model

- Added the versioned `boot.yaml` workspace schema.
- Added stable workspace and repository IDs, repository roles, portable paths,
  tool and service requirements, commands, environment requirements,
  constraints, and profiles.
- Added `boot init` discovery that records only verifiable details.
- Added `boot save` to publish a workspace through an existing workspace map.

### Workspace preparation and agent context

- Added `boot up` as the primary workspace preparation command.
- Added the local provider, separate from Git and folder workspace-map
  transports.
- Added deterministic dry-run and JSON preparation plans.
- Added `boot inspect --json` with workspace, profile, repository, command,
  requirement, environment-availability, and constraint context.
- Added active workspace context persistence.
- Existing `boot agent` delegates to a published `agent` profile when possible.

### Safety and compatibility

- Added normalized relative-path validation and root containment.
- Added duplicate, case-collision, and nested-repository validation.
- Added atomic JSON, YAML, encrypted env, and plaintext env writes.
- Plaintext env files now use mode `0600`.
- Repository cloning from placeholders now stages content, detects collisions,
  uses a cross-process lock, and swaps content into place instead of recursively
  copying partial state.
- Git operations are non-interactive and time-bounded.
- `pull --dry-run` and `agent --dry-run` no longer pull or mutate workspace-map
  state.
- Daemon one-shot failures now return a failing exit status and reject invalid
  intervals.
- Existing workspace maps, snapshots, setup, sync, hydration, daemon, and
  encrypted-env commands remain supported.

### Documentation and examples

- Added workspace, profile, provider, snapshot, agent, publishing, and reference
  documentation.
- Added multi-repository billing and shared-workspace demos.
