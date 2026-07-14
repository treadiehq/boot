# Concepts

Boot uses five main terms.

## Workspace

A workspace is the complete development context for a project or system. It
records:

- stable identity and name;
- repositories, portable paths, roles, URLs, and desired refs;
- tools and services;
- setup, development, test, and other commands;
- environment requirement names and references;
- constraints;
- profiles.

Current branch, dirty state, observed commit, absolute local path, and clone
state are observations from one machine. They are not part of the portable
workspace definition.

## Profile

A profile is a named selection from one workspace. It selects existing
repositories, tools, services, commands, and environment requirements. It can
also choose `eager` or `manual` cloning through the exact `hydrate` schema
field.

Profiles do not duplicate definitions. Version 1 intentionally has no
inheritance or general policy language.

Useful conventions are:

- `local`: full developer context;
- `agent`: scoped delegated-work context;
- `ci`: reproducibility and verification context;
- `review`: review context with read-only intent.

The local provider exposes `readOnly` in inspection output but does not enforce
filesystem permissions.

## Provider

A provider is the way a workspace is prepared. Its contract is:

1. inspect current target state;
2. produce a deterministic plan;
3. apply supported changes;
4. return structured outcomes and blockers.

Only `local` is implemented.

## Workspace map

A workspace map contains shared Boot metadata, encrypted environment data, and
per-machine observations. Git and folder transports move the map between
machines. A map is not a provider.

## Snapshot

A snapshot is a one-off JSON file written by `boot export`. Use it for an
offline move without a shared workspace map.

## Placeholders and cloning

A repository with `hydrate: manual` can start as a lightweight placeholder.
Boot can clone it with `boot hydrate`, on navigation, through a watcher, or
through the optional FUSE overlay.

These are preparation details. Agents should use `boot inspect`, not
placeholder internals.
