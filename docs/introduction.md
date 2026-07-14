# Introduction

Boot prepares project workspaces for coding agents.

Coding agents begin each task without the local context a developer carries:
which repositories form the system, where they belong, what each repository
does, which project commands to use, what services are required, and which
constraints must be respected.

A Boot **workspace** records that context in `boot.yaml`. A **profile** is a
named selection from the workspace. A **provider** is the way Boot prepares
that selection. `boot inspect --json` gives an agent the resulting context
without exposing secret values.

The primary flow is:

```text
boot init → boot up → boot inspect → work
```

Boot can also share a workspace map across machines. The map contains shared
Boot metadata and encrypted environment data. Compatibility commands support
snapshots, placeholders, lazy cloning, background sync, shell hooks, and the
optional FUSE overlay.

## Product boundaries

Boot does not replace Git, Docker, Dev Containers, Nix, mise, Devbox, or a
secrets manager. It describes the complete workspace a person or agent needs,
including multi-repository structure and project instructions.

The local provider currently creates repository structure and validates a
bounded set of tools and services. It does not install runtimes or start
services. It reports unsupported requirements as unresolved.

Boot synchronizes declared structure and encrypted environment data. It does
not synchronize uncommitted file edits.
