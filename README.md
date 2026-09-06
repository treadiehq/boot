# Boot

**Your workspace, wherever you work.**

Boot recreates your project setup on any machine or cloud agent, so you can
start working without rebuilding it by hand.

## Install

macOS or Linux:

```bash
curl -fsSL https://useboot.co/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://useboot.co/install.ps1 | iex
```

Boot requires Git.

## Get started

Run Boot from the folder that contains your project:

```bash
cd ~/code
boot init
boot up . --profile agent
boot inspect --json
```

`boot init` scans the project and creates `boot.yaml`. Review that file and
commit it with your code.

`boot up` prepares the repositories your agent needs and checks the required
tools, services, and environment variables. Add `--start` to run the service
start commands declared in `boot.yaml` and wait until each service reports
healthy.

`boot inspect --json` gives the agent a clear summary of the workspace without
including secret values.

`boot ui` opens a local web app served by the CLI itself (127.0.0.1 only) that 
lists your workspaces and prepares and launches them with one click.

## Run several agents on one project

Create a managed workspace for each task, then launch the agent inside it:

```bash
boot session create . --profile agent --name fix --storage auto
boot session run fix -- codex
boot session diff fix
boot session release fix
boot session gc
```

Sessions use real copy-on-write on APFS and supported Linux filesystems, with
explicitly reported worktree/clone fallbacks. Each session has independent files
and an index. Start from committed code, or explicitly include working changes
and prepared dependencies with `--include-working-tree` and
`--include node_modules`. Prepared includes require CoW.

GC previews by default. `--apply` removes eligible released sessions while
preserving active processes, changes, outstanding commits, and unverifiable work.
See [managed sessions](docs/sessions.md) for storage, ownership, and cleanup rules.

## Start a fresh cloud agent

Publish the reviewed workspace definition once:

```bash
boot link git@github.com:acme/billing-map.git ~/code
boot save ~/code
```

Then prepare any fresh VM, container, or CI runner without a separate install
step:

```bash
curl -fsSL https://useboot.co/agent.sh | bash -s -- \
  git@github.com:acme/billing-map.git /workspace --profile agent
```

The adapter installs Boot when needed, then runs the provider-neutral,
idempotent contract:

```bash
boot agent git@github.com:acme/billing-map.git /workspace \
  --profile agent --run-setup --ephemeral --json
```

It acquires the workspace map, realizes only the selected profile, materializes
available encrypted environment values, runs declared setup commands, and
returns runtime-validated, secret-free readiness diagnostics. The adapter's
ephemeral mode does not create or publish machine state. Pin a reviewed map
revision with `--map-commit <full-sha>`. A machine that needs Boot-managed
secrets must have the workspace key provisioned before bootstrap.

## What Boot handles

- One repository or many
- Repository paths, roles, branches, and clone URLs
- Project commands and constraints
- Required tools, services, and environment variables
- Starting declared services and verifying they are healthy (`--start`)
- Different setups for local work, coding agents, CI, and review
- One-command, profile-scoped setup on fresh cloud machines
- A local launchpad (`boot ui`) to prepare and launch workspaces in one click
- Managed agent sessions with CoW storage, recursive submodules, and conservative cleanup
- Opt-in session ports and disposable PostgreSQL databases (`--runtime`)

Boot prepares repositories, checks requirements, and starts the services you
declare. It tracks commands launched with `boot session run`; it does not replace
Git or install tools. Session runtimes assign ports and create separate PostgreSQL
databases; other external services remain shared.

## Learn more

- [Getting started](docs/getting-started.md)
- [`boot.yaml` reference](docs/boot-yaml.md)
- [Agent workflows](docs/agents.md)
- [Managed agent sessions](docs/sessions.md)
- [Session validation and storage measurements](docs/session-validation.md)
- [Agent bootstrap benchmark](docs/benchmarks.md)
- [Sharing a workspace](docs/publishing.md)
- [CLI reference](docs/reference.md)
- [Advanced features](docs/detailed.md)

## Development

```bash
pnpm install
pnpm lint
pnpm test:run
pnpm qa
```

The launchpad frontend lives in `ui/` (Nuxt + Tailwind, dev-only toolchain).
Build it once with `pnpm ui:build`; `boot ui` then serves it locally. Release
binaries embed the built assets automatically.

## License

[FSL-1.1-MIT](LICENSE)
