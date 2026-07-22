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
- `--run-setup` explicitly executes setup commands.

`boot agent <map-remote> [path]`

Acquires a published workspace map and prepares a fresh CI or cloud-agent
workspace in one idempotent invocation. A published `agent` profile is selected
by default when present.

Options:

- `--profile <name>` selects another published profile;
- `--provider local` selects the workspace provider;
- `--run-setup` explicitly executes selected setup commands;
- `--no-env` validates encrypted values without writing `.env` files;
- `--folder` treats the source as an already-synchronized folder;
- `--dry-run` previews without changing the requested workspace;
- `--json` writes one versioned result only to stdout.

The compatibility flags `--hydrate`, `--all`, `--eager`, and `--env` remain
available for maps that do not yet publish `boot.yaml`.

`boot inspect [path]`

Inspects resolved context and current state. `--profile`, `--provider`, and
`--json` are supported.

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

- `schemaVersion`, `mode`, `source`, `dryRun`, and `ready`;
- `diagnostics`, using the same secret-free workspace shape as
  `boot inspect --json`;
- `applied`, `failures`, and `warnings`.

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
