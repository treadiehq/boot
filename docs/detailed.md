# Boot — Detailed Reference

Everything `boot` can do. For the shortest path, start with the
[README](../README.md).

Boot puts the same repo layout on every laptop and cloud agent. Repos you have
not opened yet show up as tiny **placeholders**, then clone when you open them.
A fresh machine is useful in seconds instead of waiting on gigabytes of clones.

It also syncs your **environment variables** (encrypted) and can keep each
machine current in the background, so you do not build on a stale `main`.

**What it is not.** Boot isn't a replacement for Git, a live backup, or a cloud
service. It syncs your layout and secrets, not live edits.

## A Few Words You'll See A Lot

- **Map** — the saved layout: which repos exist and where each one lives.
- **Placeholder** — a tiny folder for a repo you have not cloned yet.
- **Hydrate** — Boot's word for cloning a placeholder repo.
- **Transport** — how the map moves between machines: a Git remote by default,
  or a folder already synced by another tool.

## Install

One line per machine. It downloads the standalone `boot` binary for your
platform and puts it on your PATH. No Node or build step needed.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.ps1 | iex
```

Binaries are published for macOS and Linux on `x64` and `arm64`, and Windows on
`x64` (which also runs on Windows ARM through emulation). You only need **Git**
on your PATH at runtime.

The installers honor a few environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOT_VERSION` | `latest` | release tag to install, e.g. `v0.1.0` |
| `BOOT_BIN_DIR` | macOS/Linux: `/usr/local/bin` if writable, else `~/.local/bin`. Windows: `%LOCALAPPDATA%\boot\bin` | where the `boot` binary is installed |
| `BOOT_REPO` | `treadiehq/boot` | `owner/repo` to download releases from |

```bash
# pin a specific version (macOS/Linux)
BOOT_VERSION=v0.1.0 curl -fsSL https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh | bash
```

```powershell
# pin a specific version (Windows)
$env:BOOT_VERSION = "v0.1.0"; irm https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.ps1 | iex
```

For development, build a binary with [Bun](https://bun.sh) or run from source
with Node + pnpm:

```bash
pnpm install && pnpm build:binary   # → dist/release/boot-<os>-<arch>
# or run from source:
pnpm install && pnpm dev <cmd>
```

### Updating Boot

Once installed, keep a machine up to date with:

```bash
boot update              # download the latest released binary for this platform
boot update --ref v1.2   # install a specific release tag
```

For a binary install, `boot update` re-runs the installer and fetches the latest
release. For a source checkout, it fetches the latest source and rebuilds. It
refuses to touch a checkout with local changes.

## Releasing

Releases are tag-driven. Push a semver tag and the
[`Release` workflow](../.github/workflows/release.yml) builds a standalone `boot`
binary for each platform (Linux/macOS × x64/arm64, plus Windows x64) with Bun,
ad-hoc signs the macOS binaries, and publishes them — plus a `SHA256SUMS` — as
assets on a GitHub Release. The version is baked into each binary at build time
(`--define __BOOT_VERSION__`). Because the installers and `boot update` pull from
`/releases/latest`, cutting a tag is all it takes to ship a new version.

```bash
npm version patch     # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

> The optional FUSE `mount` feature relies on the native `fuse-native` addon,
> which isn't bundled into the static binary. `boot mount` prints install help in
> the binary build; the rest of Boot (sync, clone, daemon, shell hook) works
> fully without it.

## Set Up A Machine

`boot setup` is the one command you run on each machine. It connects the
workspace, sets up encrypted env vars, installs auto-clone on `cd`, starts
background sync, and prints a health check.

> **Before the first machine:** create one private git repo to hold the layout.
> A name like `code-map` is fine. If it is a GitHub repo and you have the
> [GitHub CLI](https://cli.github.com), `boot setup` can create it for you.
> With `--folder`, you can use a synced folder instead of a git repo.

```bash
boot setup git@github.com:me/my-code-map.git ~/code
boot setup --folder ~/Dropbox/boot-map ~/code         # folder transport
boot setup … --yes                                    # accept every step (scriptable)
```

What setup does:

1. **Layout** — links a new workspace, or pulls the latest layout if it is
   already linked.
2. **Secret key** — creates or imports the key used for encrypted env vars.
3. **Shell hook** — adds the snippet that clones repos when you `cd` into them.
4. **Background sync** — installs the service that keeps the layout and clean
   repos current.
5. **On-read mount** — shows whether the optional FUSE mount is available and
   prints the exact `boot mount` command.

Prompts only appear in an interactive terminal. Use `--yes` and `--no-*` flags
for scripts. Check the result anytime with `boot doctor --system`.

## Run Boot

Once installed, call `boot`. If you are working from source, put `pnpm dev`
before any command.

```bash
boot init ~/code                      # write a default .bootignore + boot.yaml
boot export ~/code                    # save a snapshot file (boot-workspace.json)
boot list boot-workspace.json         # see what's inside a snapshot
boot import boot-workspace.json /tmp/code --lazy   # recreate it with placeholders
boot hydrate /tmp/code/apps/kplane    # clone one placeholder
boot status ~/code                    # what's cloned, what's still a placeholder
boot doctor ~/code                    # health warnings
```

From source, the same thing looks like `pnpm dev export ~/code`,
`pnpm dev import …`, and so on.

## Commands

Most people use the shared-layout commands: `setup`, `link`, `push`, `pull`,
`daemon`, `agent`, and `env`. The snapshot commands, `export`, `list`, and
`import`, are for one-time offline moves with no remote. `export` and `import`
used to be called `scan` and `restore`; those aliases still work.

| Command | What it does |
| --- | --- |
| `setup [remote] <workspacePath>` | Set up a machine in one command: layout, secrets, shell hook, background sync, and health check. |
| `init <workspacePath>` | Write a default `.bootignore` and `boot.yaml`. `--force` to overwrite. |
| `update` | Update Boot. Use `--ref <tag>` to install a specific release. |
| `export <workspacePath>` | Save this workspace's repo list to a snapshot file. Alias: `scan`. |
| `list <manifestPath>` | Show the repos in a snapshot file. |
| `import <manifestPath> <targetPath>` | Recreate folders and repos from a snapshot file. `--lazy` writes placeholders instead of cloning. Alias: `restore`. |
| `hydrate <repoPath>` | Clone a placeholder repo now. |
| `enter [targetPath]` | Clone the placeholder at or above a path. Used by the shell hook. |
| `cd [query]` | Find a repo by name and print its path, cloning it first if needed. Use `bcd` to actually jump there. |
| `shell-hook [shell]` | Print the shell snippet for auto-clone on `cd` and the `bcd` jump command. |
| `watch [workspacePath]` | Clone a placeholder when a tool writes into it. |
| `mount <workspacePath> <mountpoint>` | Open a workspace through a mount that clones repos on first read. Needs FUSE. |
| `unmount <mountpoint>` | Force-unmount a workspace mounted with `mount`. |
| `agent <remote> [workspacePath]` | Set up a CI job or cloud agent from your shared layout. |
| `env set\|import\|list\|rm\|materialize` | Store encrypted env vars in the shared layout. Use `--repo <relativePath>` for one repo. |
| `env init` | Create this machine's secret key for env vars. |
| `env key share\|receive` | Move the secret key to a new machine with a passphrase. |
| `env key revoke <label>` | Remove a shared-key entry from the map. |
| `env key export\|import` | Lower-level key transfer by clipboard, file, arg, or stdin. |
| `status <workspacePath>` | Show what is cloned, waiting, or dirty. |
| `doctor <workspacePath>` | Check a workspace for common problems. `--system` checks Boot's setup on this machine. |
| `link <remote> [workspacePath]` | Share this workspace layout with your other machines. `--folder` uses a synced folder instead of a git repo. |
| `push [workspacePath]` | Publish this machine's repo layout now. |
| `pull [workspacePath]` | Bring in repo layout changes from other machines. `--dry-run` previews. |
| `daemon start [workspacePath]` | Sync this workspace on an interval. |
| `daemon stop [workspacePath]` | Stop the running daemon for a workspace. |
| `daemon status [workspacePath]` | Show whether background sync is running and when it last synced. |
| `daemon install [workspacePath]` | Start background sync automatically when you log in. |
| `daemon uninstall [workspacePath]` | Remove automatic background sync for a workspace. |

## Ignore rules — `.bootignore`

A gitignore-style ignore file, supported at the **workspace root** and inside
**individual repos**:

```gitignore
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
- Rules are merged with Boot's built-in defaults and any
  `ignore:` list in `boot.yaml`.
- Ignored directories are never descended into during a scan.
- The snapshot file records every ignore file that was applied (`config.ignoreFiles`).

### How deep the map goes

There's no limit on nesting you'll hit in practice: Boot maps arbitrarily nested
subfolders, descending up to **12 directory levels** below the workspace root (a
safety bound so a pathological tree can't recurse forever). Every git repo (and
every placeholder) is treated as a **leaf** — Boot records it and stops, never
recursing *inside* a repo, so a repo nested within another repo isn't mapped as
its own entry. Ignored folders (`node_modules`, `dist`, …) are skipped entirely,
and symlinks aren't followed.

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

```text
apps/kplane/.boot/repo.json     # name, relativePath, remoteUrl, branch, lastCommit, hydrateStatus, createdAt
apps/kplane/.boot/README.md     # how to clone this repo
```

Run `boot hydrate apps/kplane` to clone the real repo into that folder. It clones
into a temp directory first, then moves the contents in (preserving `.boot/`),
checks out the recorded branch, updates `hydrateStatus` to `hydrated`, and adds
`.boot/` to the repo's local `.git/info/exclude` so the clone stays clean. It
never overwrites an existing repo, and leaves the placeholder intact if the
clone fails.

## Syncing the map across machines

`export` and `import` move a snapshot file by hand. `link`, `push`, and `pull`
keep the layout shared between machines. You choose one transport at `link`
time: a Git remote or a synced folder.

```bash
# First machine (already has ~/code full of repos): seed the map.
boot link git@github.com:me/my-code-map.git ~/code

# Any other machine (or a cloud agent): the structure appears as placeholders.
boot link git@github.com:me/my-code-map.git ~/code

# Day to day (optional; background sync does this for you):
boot push ~/code     # publish new/changed repos to the map
boot pull ~/code     # receive structure added on other machines
```

With background sync installed, you normally never run `push` or `pull` by hand.
They are there when you want to sync right now.

### Choosing a transport

| Transport | `link` form | Best when |
| --- | --- | --- |
| **Git** (default) | `boot link <git-url> ~/code` | You want history, safe updates, and real merges. This works everywhere Boot runs, including cloud agents. |
| **Folder** (`--folder`) | `boot link --folder ~/Dropbox/boot-map ~/code` | You already have Dropbox, iCloud Drive, Google Drive, or a network share and do not want a git repo for the map. |

Folder transport is simpler, but conflict handling belongs to the sync tool. If
two machines write at the same time, Dropbox or iCloud may create a conflicted
copy. For one person across a few machines this is usually fine. For a team,
prefer Git.

The map is split so machines never fight over one file:

```text
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
- `link` and `pull` create placeholders by default; pass `--eager` to clone
  every repo immediately. Clone one placeholder anytime with
  `boot hydrate <relativePath>`.

## Background Sync

`boot daemon` keeps your workspace current in the background. It syncs the
layout and fast-forwards clean repos when it is safe.

```bash
boot daemon start ~/code            # sync on an interval (Ctrl-C to stop)
boot daemon start ~/code --once     # one sync and exit (cron / CI / a quick check)
boot daemon status ~/code           # running? when did it last sync?
boot daemon stop ~/code             # stop the loop
```

Each sync does, in order:

1. **pull** the shared map,
2. **recreate missing folders** for repos added on other machines,
3. **fetch** every cloned repo and, when safe, **fast-forward** it,
4. **push** this machine's updated view back.

Boot is conservative. It only fast-forwards a repo that is **clean**, on a
**default branch** (`main`/`master`), and has **no local-only commits**. Dirty
repos, feature branches, diverged branches, and detached heads are reported but
not changed.

Tune it in `boot.yaml`:

```yaml
daemon:
  intervalSeconds: 60     # how often to sync
  fetch: true             # fetch remotes to assess freshness
  fastForward: true       # auto fast-forward clean default-branch repos
```

### Start It Automatically

`daemon start` runs in the foreground. To start background sync when you log in,
install it as an OS service:

```bash
boot daemon install ~/code      # launchd (macOS) / systemd --user (Linux) / Scheduled Task (Windows)
boot daemon status ~/code       # shows "Service: installed" + the last sync
boot daemon uninstall ~/code    # stop + remove it
```

- **macOS** writes `~/Library/LaunchAgents/com.boot.<id>.plist`
  (`RunAtLoad` + `KeepAlive`) and loads it with `launchctl bootstrap`.
- **Linux** writes `~/.config/systemd/user/boot-<id>.service`
  (`Restart=always`) and enables it with `systemctl --user enable --now`.
- **Windows** registers a Task Scheduler task `boot-<id>` (logon trigger,
  restart-on-failure) with `schtasks /Create /XML`, keeping the task XML under
  `~/.boot/services/` so `daemon status`/`uninstall` can find it again.

Each workspace gets its own service, so you can manage several independently.
Logs go to `~/code/.boot/daemon.log`. Remove the service with
`boot daemon uninstall`.

> Install resolves the running `boot` binary. If you're working from source,
> `pnpm build` and install the built CLI (or pass `--entry <path>`) so the
> service can start without `tsx`.

## Clone Repos When You Need Them

Placeholders keep a fresh machine tiny. You get the whole workspace layout
without cloning gigabytes you may never open. Boot can clone a placeholder the
moment you use it.

Boot offers three triggers. All use the same core behavior: never overwrite a
real repo, keep the recorded branch, preserve `.boot/`, and leave the
placeholder intact if the clone fails.

**1. Clone on `cd` (the shell hook).** Add the hook once, then navigating into
a placeholder clones it:

```bash
eval "$(boot shell-hook zsh)"     # ~/.zshrc   (also: bash | fish)
```

On Windows, add the PowerShell hook to your `$PROFILE` instead:

```powershell
Invoke-Expression (& boot shell-hook powershell | Out-String)
```

Now `cd ~/code/apps/kplane` clones `kplane` before you run a command. Under the
hood, the hook calls:

```bash
boot enter ~/code/apps/kplane     # clone the nearest placeholder at/above a path
boot enter .                      # clone here if this is a placeholder
```

`enter` walks up from the path you give it to the nearest placeholder, clones
that one repo, and does nothing if you are already in real code.

**2. Clone on first write (the watcher).** When a tool or editor writes into a
placeholder, clone it automatically:

```bash
boot watch ~/code     # foreground; clones placeholders on first write
```

The watcher uses one recursive FS watch on macOS/Windows and per-placeholder
watches on Linux. The instant a write lands inside a placeholder it clones the
real repo in place (preserving `.boot/`), then disarms that placeholder so the
clone's own writes can't re-trigger it.

**3. Clone on read (the FUSE mount).** Open the workspace through a virtual
filesystem, and even reading a file can clone its repo. `cat`, an editor open,
or `grep -r` can clone `apps/web` on the spot.

```bash
boot mount ~/code ~/code-live    # foreground; Ctrl-C (or `boot unmount`) to detach
cat ~/code-live/apps/web/package.json   # apps/web clones on this read
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

`fuse-native` is an **optional dependency**, so Boot works fully without it.
Only `boot mount` requires it, and it prints these instructions if it is
missing. The mount is a **read-write** overlay: reads and writes pass through to
the real files, and the first access into an uncloned placeholder clones it.
Edits, creates, renames, and deletes land on the real files. The clone logic
(`core/vfs.ts`) is unit-tested independently of FUSE; only the thin native
binding needs the kernel module.

> Pass `--read-only` to make reads still clone but reject writes with `EROFS`,
> handy for inspection or untrusted agents. A native macOS **File Provider**
> extension (no macFUSE install) is the remaining nicety.

## Jump to any repo — `boot cd` and `bcd`

The triggers above clone the repo you happen to touch. `boot cd` is direct:
name a repo and jump straight to it, no matter where it lives in the tree. If
the repo is still a placeholder, Boot clones it on the way.

A child process can't change its parent shell's directory, so `boot cd` *prints*
the resolved path and a tiny shell function does the `cd`. The function `bcd` is
bundled into the shell hook (`boot shell-hook`), so once that's installed:

```bash
bcd web            # fuzzy-match "web", clone it if needed, and cd in
bcd apps/api       # path fragments work too
boot cd            # no query → interactive picker of every repo in the map
```

- Matching is a boundary-aware fuzzy match over each repo's **name** and
  **relative path** (a name hit outranks an incidental path hit). With a query
  it jumps to the best match; with none it offers a picker on a TTY.
- `boot cd --print <query>` writes **only** the resolved path to stdout (logs go
  to stderr) — that's the contract `bcd` consumes. `--json` emits
  `{ path, name, relativePath, hydrated }` for scripts.
- If the repo isn't on this machine yet, boot tells you to `boot pull` first
  rather than guessing.

## Environment variables — `boot env`

Boot can keep env vars consistent across machines too. Values are encrypted
before they enter the map, so the map stays safe to host anywhere.

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
  secrets elsewhere, share the key with a passphrase. The encrypted key rides in
  the map; you transfer only the short passphrase:

```bash
boot env key share      # on a machine with the key: pick a passphrase
boot env key receive    # on the new machine: enter the passphrase
```

  The encrypted key in the map is useless without the passphrase. `boot setup`
  detects it and offers to unlock it. Remove an old entry with
  `boot env key revoke <label>`. Machines that already received the key keep it,
  so rotate the key itself if it might be compromised.

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
- A machine **without** the key can still sync the layout. Env commands just ask
  you to import the key first. Wrong key or corrupted data fails loudly instead
  of producing garbage.

## Cloud agents & CI — `boot agent`

`boot agent` sets up a CI job or cloud agent from your shared layout. It is safe
to run every time:

```bash
boot agent git@github.com:me/my-code-map.git ~/code           # link (or pull) → placeholders
boot agent git@github.com:me/my-code-map.git ~/code --eager   # clone everything up front
boot agent … --hydrate 'apps/*' 'libs/api'                    # clone only what you need
boot agent … --all --env                                      # clone everything + write .env files
boot agent … --all --dry-run                                  # preview the plan, write nothing
```

- First run **links** the workspace. Later runs **pull** and re-apply the layout.
- `--hydrate <patterns…>` clones only matching placeholders, so an agent pulls
  just the repos it needs.
- `--env` writes env files when the secret key is present, and skips with a hint
  when it is not.

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
pnpm dev <cmd>      # run the CLI from source (tsx)
pnpm build          # bundle with tsup (esm + cjs + dts; needs Node to run)
pnpm build:binary   # standalone binaries for all platforms (needs Bun) → dist/release/
pnpm test           # run vitest
pnpm lint           # typecheck with tsc --noEmit
pnpm qa             # full CLI workflow smoke test
```

## Not yet

- a native **macOS File Provider** extension so on-read cloning needs no macFUSE
  install (a signed Swift app extension, out of scope for a pure-TS CLI);
- **continuous file-content sync** of *uncommitted* work between machines (Boot
  syncs layout and secrets, not live edits).
