# Make a project Boot-ready

A project is Boot-ready when maintainers publish a valid, reviewed `boot.yaml`
that describes the workspace needed to contribute or delegate work.

Add one when a task commonly spans multiple repositories or depends on
non-obvious commands, services, environment names, or constraints.

## Maintainer checklist

1. Give the workspace a stable, namespaced ID.
2. Define repositories with paths relative to the workspace and the correct
   clone URLs.
3. Add short roles that explain why each repository exists.
4. Declare only tool and service versions the project actually requires.
5. Point commands at the repository where they run.
6. List environment names and references, never values.
7. Create an `agent` profile that includes only what the agent needs.
8. Record constraints an agent cannot infer safely.
9. Validate with `boot up --dry-run` and `boot inspect --json`.
10. Review `boot.yaml` changes like code.

## Publish through a workspace map

For a private multi-repository workspace:

```bash
boot link git@github.com:acme/billing-map.git ~/billing
boot save ~/billing
```

The workspace map contains shared Boot metadata and encrypted environment data.
AES-256-GCM protects the environment data and detects ciphertext tampering, but
it does not make the map safe to publish anywhere. Keep the map private and
control access to it. Another environment can link the map and run `boot up`.

## Publishing in source control

`boot.yaml` is an open YAML format and can be committed to a public project or
a small workspace-definition repository. Consumers can place that validated
file at their workspace root and run:

```bash
boot up /workspace --profile agent
```

Direct `boot up <git-url>` resolution is not implemented. Place a validated
`boot.yaml` at the workspace root before running `boot up`.

## Versioning

`schemaVersion` versions the workspace format independently from Boot's CLI
version, snapshot version, and workspace-map version. Readers reject unknown
versions rather than silently dropping fields.

Version 1 additions require a new schema version when they would change
meaning, remove fields, or make old writers unsafe. Migration adapters should
read old data into the current in-memory model before writing.

## Conventions

- Prefer `local`, `agent`, `ci`, and `review` profile names.
- Use repository IDs that remain stable when paths change.
- Keep paths portable and relative.
- Keep constraints specific and actionable.
- Reference existing Docker, Dev Container, Nix, mise, or other setup rather
  than rebuilding it as a generic Boot DSL.
