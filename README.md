# Boot

**Your code workspace, everywhere.**

Boot puts the same repo layout on every laptop and cloud agent. Repos show up
instantly as tiny placeholders, then clone when you open them.

It also syncs your **env vars** (encrypted) and keeps each machine current in
the background, so you never build on a stale `main`.

What Boot gives you:

- **The same workspace everywhere.** Set up a new laptop or cloud agent and your
  repos appear in the right folders in seconds.
- **Fresh code by default.** Background sync updates clean repos, so you do not
  build on yesterday's `main`.

> Boot doesn't replace Git or live-sync your edits. It syncs structure and
> secrets, not a real-time copy of your files.

## Install

**macOS / Linux** (needs `curl`):

```bash
curl -fsSL https://useboot.co/install.sh | bash
```

**Windows** (PowerShell):

```powershell
irm https://useboot.co/install.ps1 | iex
```

Installs a standalone binary (macOS/Linux on x64+arm64, Windows on x64). Git is
required for Boot's repo syncing. Update anytime with `boot update`.

## Use it

You need one private git repo to store the layout. A name like `code-map` works
well. If it is on GitHub and you have the [GitHub CLI](https://cli.github.com),
Boot can create it during setup. Otherwise create an empty private repo first.

Then run one command on each machine. It connects the workspace, sets up
encrypted env vars, installs auto-clone on `cd`, and starts background sync:

```bash
boot setup git@github.com:me/code-map.git ~/code
```

Run the same command on your next machine and your whole layout shows up as
placeholders that clone when you open them. It is safe to re-run anytime.

You do not have to remember to sync. Background sync pulls and pushes the layout
for you, so a repo you add on one machine appears on the others. `boot push` and
`boot pull` are there when you want to sync right now.

## Handy commands

| Command | What it does |
| --- | --- |
| `boot setup <remote> [path]` | Set up (or update) a machine in one shot. |
| `boot push` | Publish this machine's repo layout now. |
| `boot pull` | Bring in layout changes from other machines; `--dry-run` previews. |
| `boot cd <name>` | Find a repo by name and jump to it with `bcd`. |
| `boot hydrate <path>` | Clone a placeholder repo now. |
| `boot env key share` / `receive` | Move your encrypted secrets to a new machine with a passphrase. |
| `boot agent <remote> [path]` | Set up a CI job or cloud agent from your layout. |
| `boot update` | Update Boot itself to the latest version. |
| `boot doctor --system` | Check Boot's setup on this machine. |

Env-var sync, folder transport, FUSE mounts, and the full command
reference live in **[docs/detailed.md](docs/detailed.md)**.

## Dev

```bash
pnpm dev <cmd>      # run from source
pnpm build          # bundle (dist/index.js, needs Node to run)
pnpm test           # tests
pnpm demo           # narrated, offline two-machine walkthrough (great for showing off)
pnpm build:binary   # standalone binaries for all platforms (needs Bun) → dist/release/
```

## Not yet

- a native **macOS File Provider** extension, so on-read cloning does not need
  macFUSE;
- **continuous file-content sync** of *uncommitted* work between machines (Boot
  syncs layout and secrets, not live edits).

## License

[FSL-1.1-MIT](LICENSE)
