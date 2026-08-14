# Reference

## Canonical commands

`boot init [path]`

Discovers a workspace and writes `boot.yaml` plus `.bootignore`. Existing files
are preserved unless `--force` is supplied.

`boot up [path]`

Resolves and prepares a workspace.

Options:

- `--profile <name>` selects a profile;
- `--provider local` selects the local provider;
- `--dry-run` returns a side-effect-free plan;
- `--json` writes only structured JSON to stdout;
- `--no-env` avoids writing plaintext `.env` files;
- `--run-setup` explicitly executes setup commands;
- `--start` runs declared service start commands and waits until each service
  reports healthy.

`boot agent <map-remote> [path]`

Acquires a published workspace map and prepares a fresh CI or cloud-agent
workspace in one idempotent invocation. A published `agent` profile is selected
by default when present.

Options:

- `--profile <name>` selects another published profile;
- `--provider local` selects the workspace provider;
- `--run-setup` explicitly executes selected setup commands;
- `--start` runs declared service start commands and waits for health;
- `--no-env` validates encrypted values without writing `.env` files;
- `--folder` treats the source as an already-synchronized folder;
- `--ephemeral` prepares the target without creating or publishing machine
  identity/state;
- `--map-commit <sha>` selects an exact full 40- or 64-character Git map
  commit;
- `--dry-run` previews without changing the requested workspace;
- `--json` writes one versioned result only to stdout.

Real pinned runs require `--ephemeral`; dry-run pinning is allowed. Pinning is
available only for Git-backed maps. Ephemeral mode still clones repositories,
writes available environment files, and runs explicitly requested setup or
service commands.

The compatibility flags `--hydrate`, `--all`, `--eager`, and `--env` remain
available for maps that do not yet publish `boot.yaml`.

`boot inspect [path]`

Inspects resolved context and current state. `--profile`, `--provider`, and
`--json` are supported.

`boot ui [path]`

Serves the local launchpad on 127.0.0.1 and opens a browser: registered
workspaces, per-profile readiness, and one-click prepare/launch backed by the
same core as `boot up`. The given path is registered when it contains
`boot.yaml`; `boot init` and `boot up` also register workspaces.

Options:

- `--port <port>` selects the port (default 4400);
- `--no-open` skips launching a browser.

`boot save [path]`

Validates and publishes `boot.yaml` through the linked workspace map.

## `boot inspect --json`

Top-level fields are:

- `schemaVersion`;
- `workspace`: identity, profile, provider, root, readiness, and read-only intent;
- `repositories`: stable ID, role, absolute and relative path, state, action,
  desired/current refs, dirty state, and diagnostic detail;
- `tools` and `services`: required, observed, state, and detail;
- `commands`;
- `environment`: name, secret classification, source, availability, and
  availability source;
- `constraints`;
- `blockers`.

Environment values and decrypted secret material are never present.

Repository states are `hydrated`, `placeholder`, `missing`, or `conflict`.
Actions are `none`, `clone`, `placeholder`, `hydrate`, `update-placeholder`,
`checkout`, or `conflict`.

Requirement states are `available`, `missing`, `mismatch`, or `unsupported`.

## `boot agent --json`

The top-level bootstrap result contains:

- `schemaVersion`, `mode`, `source`, `dryRun`, `ephemeral`, and `ready`;
- `diagnostics`, using the same secret-free workspace shape as
  `boot inspect --json`;
- `applied`, `failures`, and `warnings`.

`source.commit` is the exact map commit consumed before any optional state
publication, and `source.pinned` reports whether the caller selected it.
Both inspect and bootstrap output are checked against strict Zod schemas before
serialization.

Compatibility-map results replace `diagnostics` with repository
`reconciliation`, `hydration`, and `environmentFiles` summaries. Neither shape
contains the map URL, URL credentials, secret keys, or environment values.
Readiness failures are printed as JSON before the command exits nonzero.

## Compatibility commands

Existing synchronization and lazy-cloning commands remain available:

- `setup`, `link`, `push`, and `pull`;
- `export`/`scan` and `import`/`restore`;
- `hydrate`, `enter`, `cd`, `shell-hook`, `watch`, `mount`, and `unmount`;
- `status` and `doctor`;
- encrypted `env` and key commands;
- `daemon` commands.

Run `boot <command> --help` for command-specific examples and options.

## Persisted format versions

- `boot.yaml`: `schemaVersion: 1`;
- one-off JSON snapshot: `0.2`;
- synchronized workspace map and machine state: `1`;
- encrypted blob and wrapped key: `1`.

These versions are intentionally independent.
