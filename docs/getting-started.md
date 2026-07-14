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
workspace definition:

```bash
boot up . --profile agent --run-setup
```

`boot up` exits nonzero when selected repositories or declared requirements
remain unresolved.

## Inspect the active workspace

```bash
boot inspect
boot inspect --json
```

The JSON form is stable, uncolored, and contains no secret values.

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
