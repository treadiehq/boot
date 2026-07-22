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
tools, services, and environment variables.

`boot inspect --json` gives the agent a clear summary of the workspace without
including secret values.

## Start a fresh cloud agent

Publish the reviewed workspace definition once:

```bash
boot link git@github.com:acme/billing-map.git ~/code
boot save ~/code
```

Then prepare any fresh VM, container, or CI runner with one Boot command:

```bash
boot agent git@github.com:acme/billing-map.git /workspace \
  --profile agent --run-setup --json
```

The command is provider-neutral and safe to rerun. It acquires the workspace
map, realizes only the selected profile, materializes available encrypted
environment values, optionally runs declared setup commands, and returns
secret-free readiness diagnostics. A machine that needs Boot-managed secrets
must have the workspace key provisioned before bootstrap.

## What Boot handles

- One repository or many
- Repository paths, roles, branches, and clone URLs
- Project commands and constraints
- Required tools, services, and environment variables
- Different setups for local work, coding agents, CI, and review
- One-command, profile-scoped setup on fresh cloud machines

Boot prepares repositories and checks requirements. It does not replace Git,
install tools, or start services.

## Learn more

- [Getting started](docs/getting-started.md)
- [`boot.yaml` reference](docs/boot-yaml.md)
- [Agent workflows](docs/agents.md)
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

## License

[FSL-1.1-MIT](LICENSE)
