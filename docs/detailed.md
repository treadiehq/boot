# Boot — Advanced and compatibility synchronization

This reference covers Boot's older map and snapshot workflows, lazy cloning,
background sync, encrypted environment data, and filesystem integrations. The
primary workflow is:

```bash
boot init
boot up . --profile agent
boot inspect --json
```

Start with the [README](../README.md), [concepts](concepts.md), and
[`boot.yaml` reference](boot-yaml.md). Use this page when maintaining an
existing workspace map, moving a one-off snapshot, or configuring the
compatibility synchronization features.

Boot can synchronize a repository layout, create placeholders for missing
repositories, clone them when needed, carry encrypted environment data, and
fast-forward eligible repositories in the background. It does not replace Git,
back up uncommitted edits, orchestrate generic cloud infrastructure, or sync
live file edits.

## Terms used in this reference

- **Workspace map** — shared Boot metadata and encrypted environment data.
- **Snapshot** — a one-off JSON file written by `boot export`.
- **Placeholder** — a lightweight local representation of a repository.
- **Hydrate** — the exact command and schema term for cloning a placeholder.
- **Transport** — Git or an already-synchronized folder used to move a
  workspace map. A transport is not a provider.

## Install

Run the installer once on each machine. It downloads the standalone `boot`
binary for your platform and puts it on your PATH. No Node or build step is
needed.

**macOS / Linux:**

```bash
curl -fsSL https://useboot.co/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://useboot.co/install.ps1 | iex
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
BOOT_VERSION=v0.1.0 curl -fsSL https://useboot.co/install.sh | bash
```

```powershell
# pin a specific version (Windows)
$env:BOOT_VERSION = "v0.1.0"; irm https://useboot.co/install.ps1 | iex
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

## Compatibility setup for a map-based machine

`boot setup` configures all compatibility synchronization features on one
machine. It links a workspace map, sets up encrypted environment values,
installs clone-on-`cd`, starts background sync, and prints a health check.

> **Before the first machine:** create one private Git repository for the
> workspace map.
> A name like `code-map` is fine. If it is a GitHub repo and you have the
> [GitHub CLI](https://cli.github.com), `boot setup` can create it for you.
> With `--folder`, you can use a synchronized folder instead.

```bash
boot setup git@github.com:me/my-code-map.git ~/code
boot setup --folder ~/Dropbox/boot-map ~/code         # folder transport
boot setup … --yes                                    # accept every step (scriptable)
```

What setup does:

1. **Workspace map** — links a new map, or pulls the latest metadata if it is
   already linked.
2. **Secret key** — creates or imports the key used for encrypted environment
   values.
3. **Shell hook** — adds the snippet that clones repos when you `cd` into them.
4. **Background sync** — installs the service that keeps the workspace map and
   eligible clean repositories current.
5. **On-read mount** — shows whether the optional FUSE mount is available and
   prints the exact `boot mount` command.

Prompts only appear in an interactive terminal. Use `--yes` and `--no-*` flags
for scripts. Check the result anytime with `boot doctor --system`.

## Primary workspace flow

Once installed, call `boot`. If you are working from source, put `pnpm dev`
before any command.

```bash
boot init ~/code                      # discover and write boot.yaml + .bootignore
boot up ~/code --profile agent --dry-run
boot up ~/code --profile agent
boot inspect ~/code --json
```

See the [CLI and JSON reference](reference.md) for current command options.

## Compatibility snapshot flow

Use snapshots for a one-off offline move with no workspace map:

```bash
boot export ~/code                    # save a snapshot file (boot-workspace.json)
boot list boot-workspace.json         # see what's inside a snapshot
boot import boot-workspace.json /tmp/code --lazy   # recreate it with placeholders
boot hydrate /tmp/code/apps/kplane    # clone one placeholder
boot status ~/code                    # what's cloned, what's still a placeholder
boot doctor ~/code                    # health warnings
```

From source, the same thing looks like `pnpm dev export ~/code`,
`pnpm dev import …`, and so on.

## Compatibility commands

Map workflows use `setup`, `link`, `push`, `pull`, `daemon`, `agent`, and `env`.
Snapshot workflows use `export`, `list`, and `import`. `export` and `import`
used to be called `scan` and `restore`; those aliases still work.

| Command | What it does |
| --- | --- |
| `setup [remote] <workspacePath>` | Link a workspace map, configure secrets and the shell hook, start background sync, and run a health check. |
| `init <workspacePath>` | Discover a workspace and write `.bootignore` and `boot.yaml`. `--force` to overwrite. |
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
| `agent <remote> [workspacePath]` | Set up a CI job or cloud agent from a workspace map. |
| `env set\|import\|list\|rm\|materialize` | Store encrypted environment values in the workspace map. Use `--repo <relativePath>` for one repo. |
| `env init` | Create this machine's secret key for environment values. |
| `env key share\|receive` | Move the secret key to a new machine with a passphrase. |
| `env key revoke <label>` | Remove a shared-key entry from the workspace map. |
| `env key export\|import` | Lower-level key transfer by clipboard, file, arg, or stdin. |
| `status <workspacePath>` | Show what is cloned, waiting, or dirty. |
| `doctor <workspacePath>` | Check a workspace for common problems. `--system` checks Boot's setup on this machine. |
| `link <remote> [workspacePath]` | Share a workspace map with other machines. `--folder` uses a synchronized folder instead of a Git repository. |
| `push [workspacePath]` | Publish this machine's workspace metadata now. |
| `pull [workspacePath]` | Bring in workspace metadata from other machines. `--dry-run` previews. |
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

### Scan depth

Boot scans at most **12 directory levels** below the workspace root. Every Git
repository and placeholder is a leaf: Boot records it and does not scan inside
it. A repository nested inside another repository is therefore not a separate
entry. Boot skips ignored folders (`node_modules`, `dist`, …) and does not
follow symlinks.

## Compatibility configuration in `boot.yaml`

The following older configuration is supported only for compatibility with the
map, snapshot, clone, doctor, and daemon commands. New workspace definitions
should follow the current [`boot.yaml` schema](boot-yaml.md).

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

If these compatibility fields are absent, Boot uses
`hydrate.strategy: eager`,
`defaultBranchNames: [main, master]`, `staleAfterDays: 30`,
`daemon.intervalSeconds: 60`, `daemon.fetch: true`, and
`daemon.fastForward: true`.

## Placeholders and cloning

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

## Syncing a workspace map across machines

`export` and `import` move a snapshot file by hand. `link`, `push`, and `pull`
move a workspace map between machines. Choose a Git remote or synchronized
folder when you run `link`.

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
| **Git** (default) | `boot link <git-url> ~/code` | You want history and Git merges. This works everywhere Boot runs, including cloud agents. |
| **Folder** (`--folder`) | `boot link --folder ~/Dropbox/boot-map ~/code` | You already use Dropbox, iCloud Drive, Google Drive, or a network share. |

Folder transport is simpler, but conflict handling belongs to the sync tool. If
two machines write at the same time, Dropbox or iCloud may create a conflicted
copy. For one person across a few machines this is usually fine. For a team,
prefer Git.

The workspace map separates shared metadata from per-machine state:

```text
~/code/.boot/map/              # the local map working copy (git repo, or plain files for --folder)
  workspace.json               # shared, machine-independent truth (the repo set)
  machines/<machineId>.json    # per-machine state (root path, OS, hydrate status)
~/code/.boot/link.json         # machine-local pointer to the map backend + kind (not synced)
```

- `workspace.json` is merged **structurally by `relativePath`**: concurrent
  edits from different machines combine instead of conflicting, and a repo is
  never deleted just because it's absent on one machine.
- Each machine owns its own `machines/<id>.json`. Machine identity lives in
  `~/.boot/machine.json` (override the location with `BOOT_HOME`).
- `link` and `pull` create placeholders by default; pass `--eager` to clone
  every repo immediately. Clone one placeholder anytime with
  `boot hydrate <relativePath>`.

## Background sync

`boot daemon` syncs the workspace map in the background. It can also
fast-forward eligible clean repositories.

```bash
boot daemon start ~/code            # sync on an interval (Ctrl-C to stop)
boot daemon start ~/code --once     # one sync and exit (cron / CI / a quick check)
boot daemon status ~/code           # running? when did it last sync?
boot daemon stop ~/code             # stop the loop
```

Each sync does, in order:

1. **pull** the workspace map,
2. **recreate missing folders** for repos added on other machines,
3. **fetch** every cloned repo and **fast-forward** it when it meets the
   conditions below,
4. **push** this machine's updated view back.

Boot only fast-forwards a repo that is **clean**, on a
**default branch** (`main`/`master`), and has **no local-only commits**. Dirty
repos, feature branches, diverged branches, and detached heads are reported but
not changed.

Tune this compatibility feature in `boot.yaml`:

```yaml
daemon:
  intervalSeconds: 60     # how often to sync
  fetch: true             # fetch remotes to assess freshness
  fastForward: true       # auto fast-forward clean default-branch repos
```

### Start it automatically

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

## Clone repositories when needed

Placeholders represent repository paths without cloning their content. Boot can
clone a placeholder when you use it.

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

`fuse-native` is an **optional dependency**. Only `boot mount` requires it; all
other Boot features work without it. If it is missing, `boot mount` prints
installation instructions. The mount is a **read-write** overlay: reads and
writes pass through to the real files, and the first access into an uncloned
placeholder clones it. Edits, creates, renames, and deletes land on the real
files. The core clone behavior is tested independently of FUSE; only the native
binding needs the kernel module.

> Pass `--read-only` to make reads still clone but reject writes with `EROFS`,
> when access goes through the mount. A native macOS **File Provider**
> extension for on-read cloning without macFUSE is not implemented.

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
boot cd            # no query → interactive picker of every repo in the workspace map
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
before they enter the workspace map. Encryption does not make a workspace map
safe to publish anywhere: map metadata is not encrypted, and encrypted data
still requires access control. Keep the map private.

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
  **AES-256-GCM** and stored at `.boot/map/env/…` inside the workspace map. The
  ciphertext is authenticated, so tampering is detected on decrypt.
- The **key never enters the workspace map** in plaintext. It lives
  machine-local at
  `~/.boot/secret.key` (`0600`, overridable via `BOOT_HOME`). To use the same
  secrets elsewhere, share the key with a passphrase. The encrypted key rides in
  the workspace map; you transfer only the short passphrase:

```bash
boot env key share      # on a machine with the key: pick a passphrase
boot env key receive    # on the new machine: enter the passphrase
```

  The encrypted key requires the passphrase. `boot setup` detects it and offers
  to unlock it. Remove an old entry with
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

- `boot env materialize` decrypts and writes plaintext `.env` files with mode
  `0600` (workspace root for global scope, each repository folder for repository
  scope). When the target directory is a Git repository, Boot attempts to add
  `.env` to its local `.git/info/exclude`. This is a convenience, not a
  guarantee that `.env` cannot be committed. Keep `.env` in the project's
  `.gitignore` and review staged files.
- A machine **without** the key can still sync the workspace map. Environment
  commands ask you to import the key first. A wrong key or corrupted data fails
  authentication instead of producing plaintext.

## Cloud agents and CI — `boot agent`

`boot agent` prepares a CI job or cloud agent from a workspace map. Repeated
runs are idempotent:

```bash
boot agent git@github.com:me/my-code-map.git ~/code           # link (or pull) → placeholders
boot agent git@github.com:me/my-code-map.git ~/code --eager   # clone everything up front
boot agent … --hydrate 'apps/*' 'libs/api'                    # clone only what you need
boot agent … --all --env                                      # clone everything + write .env files
boot agent … --all --dry-run                                  # preview the plan, write nothing
```

- First run **links** the workspace map. Later runs **pull** and re-apply it.
- `--hydrate <patterns…>` clones only matching placeholders, so an agent pulls
  just the repos it needs.
- `--env` writes env files when the secret key is present, and skips with a hint
  when it is not.

## Snapshot file shape

`boot export` writes a one-off JSON snapshot describing the workspace and every
repository in it. Its implementation type is `BootManifest`:

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

- a native **macOS File Provider** extension for on-read cloning without a
  macFUSE install;
- **continuous file-content sync** of *uncommitted* work between machines (Boot
  syncs workspace metadata and encrypted environment data, not live edits).
