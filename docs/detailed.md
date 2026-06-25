# boot — detailed reference

Everything `boot` can do, in depth. For a quick start, see the
[README](../README.md).

boot keeps the **shape** of your code folder in sync across machines. It looks at
a directory full of git repos, records which repos live where, and recreates that
same layout anywhere else. Repos you haven't pulled down yet show up as tiny
**placeholders** and turn into real clones the moment you open them — so a fresh
machine is useful in seconds instead of waiting on gigabytes of clones.

It also syncs your **environment variables** (encrypted), and an optional
background **daemon** keeps every machine up to date so you never build on a stale
`main`.

**What it is not.** boot isn't a replacement for Git, a live backup, or a cloud
service. It syncs the *map* of your workspace (and your secrets) — not a real-time
copy of the files you're editing.

### A few words you'll see a lot

- **Map** — a small, portable description of your workspace: which repos exist and
  where each one lives. This is the thing that travels between machines.
- **Placeholder** — a stand-in folder for a repo you haven't cloned yet.
- **Hydrate** — swap a placeholder for the real clone, either on demand or
  automatically the first time you touch it.
- **Transport** — how the map gets from machine to machine: a Git remote (the
  default) or a folder something else already syncs, like Dropbox.

## Install

One line per machine (clones, builds, and symlinks `boot` onto your PATH):

```bash
curl -fsSL https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh | bash
```

The installer honors a few environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOT_REPO` | `https://github.com/treadiehq/boot.git` | repo to clone when not run from a checkout |
| `BOOT_REF` | `main` | branch/tag/commit to install |
| `BOOT_APP_DIR` | `~/.boot/app` | where the built app lives |
| `BOOT_BIN_DIR` | `~/.local/bin` | where the `boot` symlink goes |

From a local clone instead:

```bash
pnpm install        # then `pnpm build && pnpm link --global`, or `bash scripts/install.sh`
```

> Requires Node.js >= 18 and Git on your PATH. Uses `pnpm` (via Corepack).

## One-command onboarding — `boot setup`

`boot setup` is the front door: it runs the whole wiring sequence and prints a
health summary, so a fresh machine goes from nothing to fully-synced in one step.

```bash
boot setup git@github.com:me/my-code-map.git ~/code   # interactive
boot setup --folder ~/Dropbox/boot-map ~/code         # folder transport
boot setup … --yes                                    # accept every step (scriptable)
```

It performs, in order:

1. **Map** — `link` if the workspace is new, or `pull` if it's already linked
   (so re-running is safe and idempotent).
2. **Secret key** — keeps an existing key; on a first machine offers to create
   one; on a machine that's missing the key for *existing* encrypted scopes, it
   prompts you to import it (`--import-key <base64>` to do it non-interactively).
3. **Shell hook** — offers to append `eval "$(boot shell-hook <shell>)"` to your
   rc file so repos hydrate on `cd` (`--shell`, `--no-hook`).
4. **Background daemon** — offers to install the managed launchd/systemd service
   (`--interval`, `--no-daemon`).
5. **On-read mount** — reports whether FUSE is available and the exact
   `boot mount` command (it's a foreground process, so setup doesn't start it).

Prompts only appear on a TTY; with `--yes` (or any `--no-*` flag) it runs
unattended, making it equally good for laptops and provisioning scripts. Verify
the result anytime with `boot doctor --system`.

## Running boot

Once installed, just call `boot`. If you're working from a clone instead, put
`pnpm dev` in front of any command to run it straight from source.

```bash
boot init ~/code                      # write a default .bootignore + boot.yaml
boot export ~/code                    # save a snapshot file (boot-workspace.json)
boot list boot-workspace.json         # see what's inside a snapshot
boot import boot-workspace.json /tmp/code --lazy   # recreate it elsewhere as placeholders
boot hydrate /tmp/code/apps/kplane    # clone one placeholder
boot status ~/code                    # what's hydrated, what's still a placeholder
boot doctor ~/code                    # health warnings
```

From a clone during development the same thing looks like
`pnpm dev export ~/code`, `pnpm dev import …`, and so on.

## Commands

> **Two tiers.** The everyday path is the **map** workflow (`setup`, `link`,
> `push`, `pull`, `daemon`, `agent`, `env`) — live, continuous sync across
> machines. The **snapshot** commands (`export`, `list`, `import`) are a
> lower-level, offline path: a one-shot portable file with no remote. Most
> people only need the map workflow; `boot --help` groups them this way.
> (`export`/`import` were previously `scan`/`restore`, which still work as
> aliases.)

| Command | What it does |
| --- | --- |
| `setup [remote] <workspacePath>` | One-command onboarding: link/pull → secret key → shell hook → managed daemon → health summary. `--folder`, `--eager`, `-y, --yes`, `--no-hook`, `--no-daemon`, `--no-key`, `--import-key <base64>`, `--shell <shell>`, `--interval <s>`, `--mount <mnt>`. |
| `init <workspacePath>` | Write a default `.bootignore` and `boot.yaml`. `--force` to overwrite. |
| `export <workspacePath>` | *(snapshot, lower-level; alias `scan`)* Recursively find git repos and write a portable snapshot file. `--output <file>` to change the path. |
| `list <manifestPath>` | *(snapshot, lower-level)* Print a clean table of repos in a snapshot file. |
| `import <manifestPath> <targetPath>` | *(snapshot, lower-level; alias `restore`)* Recreate folders and clone repos from a snapshot file. `--lazy` writes placeholders instead of cloning. Never overwrites an existing repo. |
| `hydrate <repoPath>` | Clone a placeholder repo into its folder and mark it hydrated. |
| `enter [targetPath]` | Hydrate the nearest placeholder at/above a path — the on-access trigger. `-q, --quiet` for the shell hook. |
| `shell-hook [shell]` | Print a `zsh`/`bash`/`fish` snippet that runs `enter` on every `cd`, so navigating into a placeholder hydrates it. |
| `watch [workspacePath]` | Watch a workspace and hydrate placeholders the moment a tool writes into one. `--debounce <ms>`. |
| `mount <workspacePath> <mountpoint>` | Mount the workspace as a read-write virtual FS that hydrates a repo on first **read** (`cat`, editor open, grep). Needs FUSE (`fuse-native` + macFUSE/libfuse). `--read-only`, `--debug`. |
| `unmount <mountpoint>` | Force-unmount a workspace mounted with `mount`. |
| `agent <remote> [workspacePath]` | One-shot, idempotent bootstrap for CI / cloud agents: link-or-pull, then optionally hydrate. `--eager`, `--all`, `--hydrate <patterns...>`, `--env`, `--folder`, `--dry-run` (preview the plan). |
| `env set\|import\|list\|rm\|materialize` | Sync **encrypted env vars** across machines via the map. `--repo <relativePath>` to scope to one repo; `-C <path>` for the workspace. |
| `env init` | Create the machine-local secret key that encrypts env vars (never synced). |
| `env key share\|receive` | Move the key to a new machine through the map, encrypted under a passphrase. `share` escrows it; `receive` unlocks it. You transfer a short passphrase, not the raw key. `--passphrase`, `--force`. |
| `env key revoke <label>` | Prune a stale escrowed-key entry (e.g. a retired machine) from the map keyring. Stops *future* unlocks; rotate the key itself if it may be compromised. |
| `env key export\|import` | Lower-level key transfer. `export` copies to the clipboard by default (`--file`, `--stdout`); `import` reads an arg, `--file`, or stdin. |
| `status <workspacePath>` | Show hydrated repos, placeholders, dirty repos, and other folders. |
| `doctor <workspacePath>` | Print warnings (dirty repos, no remote, off-main, placeholders, stale, missing lockfiles, missing ignore file, generated folders). `--system` instead checks boot's own wiring (link, secret key, shell hook, daemon/service, FUSE). |
| `link <remote> [workspacePath]` | Connect a workspace to a shared **map**, publish what's here, and recreate everything else as placeholders. `--eager` clones instead. `--folder` treats `<remote>` as an already-synced folder (Dropbox/Drive/…) instead of a git URL. |
| `push [workspacePath]` | Scan this workspace and publish its structure to the shared map. |
| `pull [workspacePath]` | Fetch the shared map and recreate any missing structure. `--eager` clones instead of writing placeholders. `--dry-run` prints the plan without writing. |
| `daemon start [workspacePath]` | Run the background sync loop (pull → reconcile → fast-forward → push). `--once`, `--interval <s>`, `--eager`, `--no-fetch`, `--no-fast-forward`. |
| `daemon stop [workspacePath]` | Stop the running daemon for a workspace. |
| `daemon status [workspacePath]` | Show whether the daemon is running, whether a managed service is installed, and the last sync. |
| `daemon install [workspacePath]` | Install the daemon as a managed OS service (launchd on macOS, systemd on Linux) so it starts on boot. `--interval <s>`, `--entry <path>`. |
| `daemon uninstall [workspacePath]` | Stop and remove the managed service for a workspace. |

## Ignore rules — `.bootignore`

A gitignore-style ignore file, supported at the **workspace root** and inside
**individual repos**:

```
node_modules/
.next/
dist/
build/
target/
.venv/
.env
.env.local
*.log
```

- Directory rules end with `/`, plain names match files or directories, and
  `*`/`?` globs match within a single path segment. (Negation `!` is not yet
  supported.)
- Rules are merged with boot's built-in defaults and any
  `ignore:` list in `boot.yaml`.
- Ignored directories are never descended into during a scan.
- The snapshot file records every ignore file that was applied (`config.ignoreFiles`).

## Workspace config — `boot.yaml`

An optional, zod-validated config file at the workspace root:

```yaml
workspace:
  name: dante-code
hydrate:
  strategy: manual        # eager | manual
ignore:
  - node_modules
  - .next
  - dist
doctor:
  defaultBranchNames:
    - main
    - master
  staleAfterDays: 30
daemon:
  intervalSeconds: 60
  fetch: true
  fastForward: true
```

If absent, sane defaults are used (`hydrate.strategy: eager`,
`defaultBranchNames: [main, master]`, `staleAfterDays: 30`,
`daemon.intervalSeconds: 60`, `daemon.fetch: true`, `daemon.fastForward: true`).

## Placeholders & hydration

`boot import --lazy` recreates the folder tree but, instead of cloning, drops a
placeholder in each repo folder:

```
apps/kplane/.boot/repo.json     # name, relativePath, remoteUrl, branch, lastCommit, hydrateStatus, createdAt
apps/kplane/.boot/README.md     # how to hydrate this repo
```

Run `boot hydrate apps/kplane` to clone the real repo into that folder. Hydration
clones into a temp directory first, then moves the contents in (preserving
`.boot/`), checks out the recorded branch, updates `hydrateStatus` to
`hydrated`, and adds `.boot/` to the repo's local `.git/info/exclude` so the
clone stays clean. It never overwrites an existing repo, and leaves the
placeholder intact if the clone fails.

## Syncing the map across machines

`export`/`import` move a snapshot file by hand. `link`/`push`/`pull` make the map
**sync itself** — no files to email around. The map is carried by a pluggable
**transport**, which you choose once at `link` time; every other command works
the same no matter which backend you picked.

```bash
# First machine (already has ~/code full of repos): seed the map.
boot link git@github.com:me/my-code-map.git ~/code

# Any other machine (or a cloud agent): the structure appears as placeholders.
boot link git@github.com:me/my-code-map.git ~/code

# Day to day:
boot push ~/code     # publish new/changed repos to the map
boot pull ~/code     # receive structure added on other machines
```

### Choosing a transport

| Transport | `link` form | Best when |
| --- | --- | --- |
| **Git** (default) | `boot link <git-url> ~/code` | You want history, atomic updates, and real merges for concurrent edits. Runs everywhere boot does, including fresh cloud agents. boot commits/pulls with its own bookkeeping identity — you never touch git directly. |
| **Folder** (`--folder`) | `boot link --folder ~/Dropbox/boot-map ~/code` | You'd rather not host a git remote and already have a folder kept in sync by Dropbox / iCloud Drive / Google Drive / a network share. boot just mirrors the map to/from that folder. |

The folder transport drops the "you must host a git remote" requirement, but it
leans on the syncing tool for conflict handling: under *truly concurrent* writes
from two machines, whatever Dropbox/iCloud does (e.g. a "conflicted copy" file)
is what you get, instead of git's merge. boot minimizes that window by always
**pulling before it pushes**, and the map is split per-machine so the only shared
file is `workspace.json` (merged structurally). For a single person across a few
machines this is a non-issue; for a team, prefer git.

The map is split so machines never fight over one file:

```
~/code/.boot/map/              # the local map working copy (git repo, or plain files for --folder)
  workspace.json               # shared, machine-independent truth (the repo set)
  machines/<machineId>.json    # per-machine state (root path, OS, hydrate status)
~/code/.boot/link.json         # machine-local pointer to the map backend + kind (not synced)
```

- `workspace.json` is merged **structurally by `relativePath`**: concurrent
  edits from different machines combine instead of conflicting, and a repo is
  never deleted just because it's absent on one machine.
- Each machine owns its own `machines/<id>.json`, so machine state never
  conflicts. Machine identity lives in `~/.boot/machine.json` (override the
  location with `BOOT_HOME`).
- `link`/`pull` reconcile **lazily** by default (placeholders); pass `--eager`
  to clone. Hydrate a placeholder anytime with `boot hydrate <relativePath>`.

## The daemon — `boot daemon`

`link`/`push`/`pull` are still commands you run. The daemon turns them into a
loop so the workspace stays current **with no effort** — and keeps you from ever
building on a stale base.

```bash
boot daemon start ~/code            # sync forever on an interval (Ctrl-C to stop)
boot daemon start ~/code --once     # one sync and exit (cron / CI / a quick check)
boot daemon status ~/code           # running? when did it last sync?
boot daemon stop ~/code             # stop the loop
```

Each tick does, in order:

1. **pull** the shared map,
2. **reconcile** — write placeholders for repos added on other machines,
3. **freshness** — `git fetch` every hydrated repo and, when it's safe,
   **fast-forward** it to its remote,
4. **push** this machine's updated view back.

The freshness step is deliberately conservative — it only ever fast-forwards a
repo that is **clean**, on a **default branch** (`main`/`master`), and has **no
local-only commits**. Everything else is *reported, never changed*: dirty repos,
diverged branches, feature branches, and detached heads are left exactly as you
left them. This is the cure for "I spun up a worktree and forgot to pull latest
main". State lives in `~/code/.boot/daemon.json` (machine-local, not synced).

Tune it in `boot.yaml`:

```yaml
daemon:
  intervalSeconds: 60     # how often to sync
  fetch: true             # fetch remotes to assess freshness
  fastForward: true       # auto fast-forward clean default-branch repos
```

### Run it as a managed service

`daemon start` runs in the foreground. To have it start on boot and stay running
in the background, install it as an OS service:

```bash
boot daemon install ~/code      # launchd LaunchAgent (macOS) / systemd --user unit (Linux)
boot daemon status ~/code       # shows "Service: installed" + the last sync
boot daemon uninstall ~/code    # stop + remove it
```

- **macOS** writes `~/Library/LaunchAgents/com.boot.<id>.plist`
  (`RunAtLoad` + `KeepAlive`) and loads it with `launchctl bootstrap`.
- **Linux** writes `~/.config/systemd/user/boot-<id>.service`
  (`Restart=always`) and enables it with `systemctl --user enable --now`.

Each workspace gets its own service (`<id>` is a hash of the workspace path), so
you can manage several independently. Logs go to `~/code/.boot/daemon.log`. The
service runs `boot daemon start <workspace>` under the hood, so it restarts on
boot/crash; remove it with `daemon uninstall` (a plain `daemon stop` would just
be relaunched by the service manager).

> Install resolves the running `boot` binary. If you're working from source,
> `pnpm build` and install the built CLI (or pass `--entry <path>`) so the
> service can start without `tsx`.

## On-access hydration — touch it and it appears

Placeholders keep a fresh machine tiny: you get the whole *shape* of your
workspace without cloning gigabytes you may never open. The last mile is making
a placeholder **materialise the moment you actually use it**, instead of running
`boot hydrate` by hand.

boot offers **three** triggers, in increasing order of magic (and of setup).
All of them funnel through the same `hydratePlaceholder` core, so behaviour is
identical: never overwrite a real repo, keep the recorded branch, preserve
`.boot/`, and leave the placeholder intact if the clone fails.

**1. Hydrate on `cd` (the shell hook).** Add the hook once and navigating into
any part of the workspace pulls it down right then:

```bash
eval "$(boot shell-hook zsh)"     # ~/.zshrc   (also: bash | fish)
```

Now `cd ~/code/apps/kplane` hydrates `kplane` in the background before you even
run a command. Under the hood the hook just calls the on-access trigger:

```bash
boot enter ~/code/apps/kplane     # hydrate the nearest placeholder at/above a path
boot enter .                      # i.e. "materialise wherever I am" (no-op if nothing lazy)
```

`enter` walks up from the path you give it to the nearest placeholder, hydrates
that one repo, and does nothing if you're already in real, hydrated code — so
it's safe to fire on *every* directory change.

**2. Hydrate on first touch (the watcher).** When a tool or editor writes into a
placeholder, hydrate it automatically:

```bash
boot watch ~/code     # foreground; hydrates placeholders on first write activity
```

The watcher uses one recursive FS watch on macOS/Windows and per-placeholder
watches on Linux. The instant a write lands inside a placeholder it clones the
real repo in place (preserving `.boot/`), then disarms that placeholder so the
clone's own writes can't re-trigger it.

**3. Hydrate on read (the FUSE mount).** The deepest integration: expose the
workspace as a virtual filesystem where even a *passive read* materialises a
repo. A bare `cat mnt/apps/web/package.json` — or an editor opening the file, or
a `grep -r` — clones `apps/web` on the spot, transparently.

```bash
boot mount ~/code ~/code-live    # foreground; Ctrl-C (or `boot unmount`) to detach
cat ~/code-live/apps/web/package.json   # apps/web hydrates on this read
boot unmount ~/code-live
```

This needs a system FUSE and the optional `fuse-native` module:

```bash
# macOS
brew install --cask macfuse        # then approve the system extension in Settings
# Linux
sudo apt install fuse3 libfuse-dev # or your distro's equivalent
# then, in the repo
pnpm add fuse-native
```

`fuse-native` is an **optional dependency** — boot installs and works fully
without it; only `boot mount` requires it, and it prints these exact instructions
if it's missing. The mount is a **read-write** overlay: reads and writes pass
straight through to the underlying files, and the first access *into* an
un-hydrated placeholder clones it first (`getattr`/`readdir`/`open` — and any
write — all trigger it). Edits, creates, renames, and deletes land on the real
files. The hydration "brain" (`core/vfs.ts`) is unit-tested independently of FUSE
(reads, writes, and the read-only guard); only the thin native binding needs the
kernel module.

> Pass `--read-only` to make reads still hydrate but reject writes with `EROFS` —
> handy for inspection or untrusted agents. A native macOS **File Provider**
> extension (no macFUSE install) is the remaining nicety.

## Environment variables — `boot env`

"Set up env vars and keep them consistent across machines" is one of the original
pain points. boot syncs env vars through the same map repo, **encrypted at rest**
so the map stays safe to host anywhere.

```bash
boot env init                                   # create this machine's secret key
boot env set API_KEY=sk-123 DB_URL=postgres://… # workspace-global vars
boot env set TOKEN=abc --repo apps/web          # scope to one repo
boot env import .env                             # bulk-import an existing dotenv
boot env list                                    # keys shown, values masked
boot env materialize                             # write .env files into the workspace
```

How it works:

- Each scope (workspace-global, or per-repo by `relativePath`) is encrypted with
  **AES-256-GCM** and stored at `.boot/map/env/…` inside the synced map. The
  ciphertext is authenticated, so tampering is detected on decrypt.
- The **key never enters the map** in plaintext. It lives machine-local at
  `~/.boot/secret.key` (`0600`, overridable via `BOOT_HOME`). To use the same
  secrets elsewhere, the recommended way is a **passphrase-protected escrow**
  that rides the map — you transfer a short passphrase out-of-band, never the
  44-char key:

```bash
boot env key share      # on a machine with the key: pick a passphrase
                        #   → wraps the key (scrypt + AES-256-GCM) into keyring.json in the map
boot env key receive    # on the new machine: enter the passphrase → key installed
```

  The wrapped blob in the map is inert without the passphrase. `boot setup`
  detects an escrowed key and offers to unlock it during the secret-key step.
  Prune a stale entry (a machine you've retired) with `boot env key revoke
  <label>` — that stops future unlocks, though machines that already received
  the key keep it, so rotate the key itself if it might be compromised.

- If you'd rather hand-carry the raw key, the lower-level commands still exist.
  `export` copies to the clipboard by default (so it stays out of shell history),
  or use `--file <path>` / `--stdout`; `import` reads an argument, `--file`, or
  stdin:

```bash
boot env key export                 # → clipboard (or --file secret.key / --stdout)
boot env key import --file secret.key
cat secret.key | boot env key import   # or pipe it in
```

- `boot env materialize` decrypts and writes plain `.env` files into the workspace
  (workspace root for global, each repo's folder for repo scopes) and adds `.env`
  to the repo's `.git/info/exclude` so it can never be committed by accident.
- A machine **without** the key can still sync structure; env commands just tell
  it to import the key first. Wrong key or corrupted data fails loudly instead of
  producing garbage.

## Cloud agents & CI — `boot agent`

`boot agent` is a one-shot, **idempotent**, non-interactive bootstrap meant to run
at the top of a CI job or a fresh cloud-agent container:

```bash
boot agent git@github.com:me/my-code-map.git ~/code           # link (or pull) → placeholders
boot agent git@github.com:me/my-code-map.git ~/code --eager   # clone everything up front
boot agent … --hydrate 'apps/*' 'libs/api'                    # hydrate only what you need
boot agent … --all --env                                      # hydrate everything + write .env files
boot agent … --all --dry-run                                  # preview the blast radius, write nothing
```

- First run **links** the workspace; later runs just **pull** and re-apply
  structure — safe to run every time.
- `--hydrate <patterns…>` materialises only the placeholders whose `relativePath`
  matches (simple `*` globs), so an agent pulls **just the repos it touches**
  instead of the whole world.
- `--env` materialises env vars when the secret key is present, and silently skips
  (with a hint) when it isn't — so the same command works with or without secrets.

## Snapshot file shape

This is what `boot export` writes (the "manifest"): one JSON document describing
the workspace and every repo in it.

```ts
type BootManifest = {
  version: "0.2";
  createdAt: string;
  workspace: { rootName: string; sourcePath: string };
  config: {
    ignoreFiles: Array<{
      path: string;                 // posix, relative to the workspace root
      scope: "workspace" | "repo";
      rules: string[];
    }>;
    defaultIgnoreRules: string[];
  };
  repos: Array<{
    name: string;
    relativePath: string;           // always posix, relative to the workspace root
    absolutePath: string;
    remoteUrl: string | null;
    currentBranch: string | null;
    dirty: boolean;
    lastCommit: string | null;
    packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
    projectType: "node" | "python" | "go" | "rust" | "unknown";
    detectedFiles: string[];
    ignoredHints: string[];
    hydrate: {
      status: "local" | "placeholder" | "hydrated";
      strategy: "eager" | "manual";
    };
  }>;
};
```

## Scripts

```bash
pnpm dev <cmd>   # run the CLI from source (tsx)
pnpm build       # bundle with tsup (esm + cjs + dts)
pnpm test        # run vitest
pnpm lint        # typecheck with tsc --noEmit
```

## Not yet

Two things are still ahead — each needs platform work this repo can't ship on its own:

- a native **macOS File Provider** extension so on-read hydration needs no macFUSE
  install (a signed Swift app extension, out of scope for a pure-TS CLI);
- **continuous file-content sync** of *uncommitted* work between machines (boot
  deliberately syncs the structural map, not a live file replica — a real-time
  replication backend is a separate product surface).
