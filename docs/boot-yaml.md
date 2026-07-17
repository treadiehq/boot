# `boot.yaml`

`boot.yaml` is Boot's human-readable, agent-readable workspace definition.
Schema version 1 is strict: unknown fields fail validation.

```yaml
schemaVersion: 1

workspace:
  id: acme/billing
  name: Billing
  description: Billing product and shared services

repositories:
  web:
    url: https://github.com/acme/web.git
    path: web
    role: customer billing UI
    ref: main
    hydrate: manual
  billing:
    url: https://github.com/acme/billing.git
    path: services/billing
    role: invoices and subscriptions
    ref: main

tools:
  node: "24"
  pnpm: "10"

services:
  postgres:
    type: postgres
    version: "17"
    description: billing development database

commands:
  setup:
    run: pnpm install
    repository: billing
  test:
    run: pnpm test
    repository: billing

env:
  required:
    - name: STRIPE_API_KEY
      secret: true
      source: boot
    - NODE_ENV

constraints:
  - Never run commands against production billing data

profiles:
  local:
    repositories: all
    hydrate: manual
  agent:
    repositories:
      - web
      - billing
    tools: all
    services:
      - postgres
    commands:
      - test
    env:
      - STRIPE_API_KEY
    hydrate: eager

defaults:
  profile: local
```

## Repositories

Repository keys are stable identifiers. `path` must be a normalized, relative
POSIX path. Absolute paths, `..`, backslashes, duplicate paths, case-colliding
paths, and nested repository definitions are rejected.

`ref` is the requested Git state. A machine's current branch is reported
separately. Boot refuses to switch a dirty repository to another ref.

`hydrate` is `manual` or `eager`; a profile-level value overrides repository
values.

## Tools

Tools map names to required versions. The local provider checks `node`,
`pnpm`, `npm`, `yarn`, `bun`, `python`, `python3`, `go`, `rust`, and `git`.
Unknown adapters are reported as unsupported.

Version matching supports exact prefixes such as `"24"` plus common `>=`, `>`,
`<=`, `<`, `^`, and `~` expressions.

## Services

Services have a type, optional version, and description. The local provider can
verify running PostgreSQL, Redis, and Docker services. It does not install or
start them. Unknown types remain visible as unresolved requirements.

## Commands

A command is a string or an object containing `run`, optional `repository`, and
optional `description`. Commands are context for agents. Setup commands execute
only when `boot up --run-setup` is explicitly supplied.

## Environment requirements

String shorthand declares a secret requirement. Object form adds a description,
`secret`, and optional source such as `process` or `boot`.

Inspection reports names, references, and availability only. It never returns
values. During `boot up`, Boot writes selected encrypted values to plaintext
`.env` files with mode `0600`; use `--no-env` to validate without writing them.

## Profiles

Each selection is either `all` or an explicit list of definition IDs; `env`
selections use environment variable names. Omitted selections mean all
available definitions. References to unknown definitions fail validation.

## Constraints

Constraints are human-readable instructions exposed through inspection. Boot
does not claim to enforce them.

## Compatibility fields

The same file can retain the older `ignore`, `doctor`, `daemon`, and
`hydrate.strategy` configuration. These fields exist for compatibility with
the synchronization commands. They control local scanning, cloning, and
background sync; they are not part of the primary workspace flow.
