# Boot

**Dropbox for `~/[code]` — it syncs the _map_ of your workspace, not the files.**

You have a folder full of git repos. boot remembers its shape, which repos live
where, and recreates it on any other machine. Repos arrive as tiny
**placeholders** and turn into real clones the moment you open them, so a new
laptop (or cloud agent) is ready in seconds, not gigabytes.

It also syncs your **env vars** (encrypted) and runs a small background **daemon**
so no machine ever builds on a stale `main`.

Two promises, really:

- **Never build on a stale base.** The daemon keeps every machine current and
  fast-forwards clean repos, so you stop wasting time on "wait, why did it build
  the old `main`?"
- **A fresh box or cloud agent has your exact workspace in seconds.** One command
  and your whole layout is there, repos hydrate the moment you touch them.

> boot doesn't replace Git or live-sync your edits. It syncs structure and
> secrets, not a real-time copy of your files.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh | bash
```

Installs a standalone binary (Linux/macOS, x64/arm64) — just needs `curl`. Git
is required for boot's repo syncing. Update anytime with `boot update`.

## Use it

One command sets up a machine. It links the workspace, creates a secret key,
installs the shell hook and background daemon, and prints a health check:

```bash
boot setup git@github.com:me/my-code-map.git ~/code
```

Run the same command on your next machine and your whole layout shows up as
placeholders that hydrate when you touch them. It's safe to re-run anytime.

## Handy commands

| Command | What it does |
| --- | --- |
| `boot setup <remote> [path]` | Set up (or update) a machine in one shot. |
| `boot push` | Publish this machine's layout to the shared map. |
| `boot pull` | Pull the latest layout; add `--dry-run` to preview first. |
| `boot hydrate <path>` | Turn a placeholder into a real clone. |
| `boot env key share` / `receive` | Move your encrypted secrets to a new machine with a passphrase. |
| `boot agent <remote> [path]` | One-shot bootstrap for CI / cloud agents. |
| `boot update` | Update boot itself to the latest version. |
| `boot doctor --system` | Check how a machine is wired up (link, key, hook, daemon, FUSE). |

Env-var sync, the Dropbox-folder transport, FUSE mounts, and the full command
reference live in **[docs/detailed.md](docs/detailed.md)**.

## Dev

```bash
pnpm dev <cmd>      # run from source
pnpm build          # bundle (dist/index.js, needs Node to run)
pnpm test           # tests
pnpm build:binary   # standalone binaries for all platforms (needs Bun) → dist/release/
```

## Not yet

- a native **macOS File Provider** extension so on-read hydration needs no macFUSE
  install (a signed Swift app extension, out of scope for a pure-TS CLI);
- **continuous file-content sync** of *uncommitted* work between machines (boot
  deliberately syncs the structural map, not a live file replica, a real-time
  replication backend is a separate product surface).


## License

[FSL-1.1-MIT](LICENSE)
