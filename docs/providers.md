# Providers

A provider is the way Boot prepares a workspace.

The workspace and profile remain stable while the execution environment may
change.

```bash
boot up . --profile agent --provider local
```

## Local provider

`local` is the only implemented provider. It:

- inspects repository paths without overwriting unrelated directories;
- creates placeholders or clones selected repositories;
- updates a placeholder when its repository URL or requested branch changes;
- refuses mismatched remotes and will not switch branches over uncommitted work;
- clones into a staging directory, then swaps the completed repository into
  place while holding a cross-process lock;
- validates supported tools and running services;
- finds selected environment variables in encrypted storage without exposing
  their values;
- optionally executes explicit setup commands;
- reports structured results and blockers.

The local provider does not install runtimes, start services, enforce read-only
filesystem policy, or provision containers.

## Provider contract

The internal interface has three operations:

- `inspect(root, workspace)` returns current repository and requirement state;
- `plan(root, workspace)` returns deterministic actions and blockers;
- `apply(root, workspace, plan, options)` applies supported actions and returns
  structured successes, failures, and final readiness.

Providers must be idempotent, reject unsafe paths, preserve unrelated user
content, avoid secret values in results, and never report unsupported work as
complete.

## Creating another provider

The TypeScript interface supports Boot's core architecture. It is not a public
plugin API. A future remote provider needs explicit answers for:

- target creation and lifecycle;
- repository credentials and immutable refs;
- tool and service capabilities;
- encrypted environment delivery;
- command execution and cancellation;
- read-only enforcement;
- structured logs and cleanup.

A workspace map only moves shared Boot metadata and encrypted environment data.
It does not prepare a remote workspace.

No Docker, E2B, Daytona, Codespaces, or remote-VM provider is currently
available.
