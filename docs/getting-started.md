# Getting started

## Install

```bash
curl -fsSL https://useboot.co/install.sh | bash
```

Git is required. The binary supports macOS, Linux, and Windows.

## Create a workspace

Place related repositories below one workspace root, then run:

```bash
cd ~/code
boot init
```

`boot init` writes `boot.yaml` and `.bootignore`. It can detect:

- Git repositories and their portable paths;
- package-manager and Node requirements declared by `package.json`;
- setup, development, and test scripts;
- required names from environment example files;
- services backed by images in Compose files.

Discovery only records details it can verify. Add repository roles,
constraints, and narrower profiles manually.

## Preview and run `boot up`

```bash
boot up . --profile agent --dry-run
boot up . --profile agent
```

Use `--run-setup` only when you intend to execute setup commands from the
workspace definition, and `--start` to run declared service start commands
and wait for each service to report healthy:

```bash
boot up . --profile agent --run-setup --start
```

Services start after `.env` files are written and before setup commands run,
so setup steps such as migrations can reach a running database.

`boot up` exits nonzero when selected repositories or declared requirements
remain unresolved.

## Inspect the active workspace

```bash
boot inspect
boot inspect --json
```

The JSON form is stable, uncolored, and contains no secret values.

## Open the launchpad

```bash
boot ui
```

The launchpad is a local web app served by the CLI itself (127.0.0.1 only).
It lists every workspace Boot has touched, shows per-profile readiness, and
prepares and launches a workspace with one click — the button runs the same
`boot up --run-setup --start` the terminal would.

## Publish across machines

Link a private Git repository as the workspace map:

```bash
boot link git@github.com:me/code-map.git ~/code
boot save ~/code
```

Then, elsewhere:

```bash
boot link git@github.com:me/code-map.git ~/code
boot up ~/code --profile local
```

The `local` profile can select the full workspace.

For a fresh CI runner or cloud agent, the link-or-pull and realization steps
are one idempotent command:

```bash
boot agent git@github.com:me/code-map.git /workspace --profile agent
```

Add `--run-setup` when the selected setup commands should execute, and `--json`
when an agent needs one versioned, secret-free result on stdout:

```bash
boot agent git@github.com:me/code-map.git /workspace \
  --profile agent --run-setup --json
```

The profile is resolved before repositories are created, so excluded
repositories are not cloned or represented by new placeholders. Tools are
verified, never installed; services are verified, and started only when
`--start` is supplied and `boot.yaml` declares how. Missing selected requirements
produce diagnostics and a nonzero exit.
