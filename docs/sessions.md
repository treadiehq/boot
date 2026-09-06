# Managed agent sessions

A session groups the repositories selected by one resolved Boot profile. It
records immutable base commits, creates independent working directories and
indexes, launches an agent there, and retains the result until cleanup is safe.
`boot agent` remains the existing bootstrap command for fresh CI/cloud machines.

```bash
boot session create . --profile agent --name fix --storage auto
boot session run fix -- codex
boot session inspect fix --json
boot session diff fix
boot session release fix
boot session gc
boot session gc --apply
```

Create uses the `agent` profile when present, otherwise the workspace's default.
An explicit missing profile is an error. Selected repositories must already be
hydrated. Setup, ordinary service startup, merging, pushing, and publishing never
happen automatically. Opting into `--runtime` provisions the selected managed
resources described below. `ready` in session metadata means provisioning completed; run
`boot inspect --json` in the session to check runtime requirements.

## Storage and prepared files

| Requested storage | Behavior |
| --- | --- |
| `auto` | Native CoW, then managed Git worktree, then ordinary clone if worktree creation fails. Reports the actual backend and fallback reason per repository. |
| `cow` | Native CoW is mandatory. A failed primitive is an error, never a full-copy fallback. |
| `worktree` | Independent working directory, HEAD, and index; Git objects and normal refs/configuration are shared in a Boot-owned seed. |
| `clone` | Ordinary independent clone without hard links or object alternates. |

APFS uses `clonefile(2)` through a small native helper. Windows uses
`FSCTL_DUPLICATE_EXTENTS_TO_FILE` on local ReFS volumes. NTFS uses the normal
worktree/clone fallback; explicit `cow` fails on NTFS. Linux uses Node's
`COPYFILE_FICLONE_FORCE`, backed by the filesystem reflink operation. Capability
is actually probed in the selected store, and each file operation remains strict.
No FUSE driver or custom filesystem is involved. macOS releases built by the
release workflow embed signed helpers for arm64/x64. Source/npm installs, or
macOS binaries cross-built on another OS, require Apple command line tools once
to compile and cache the helper. Linux requires a filesystem supporting reflinks;
Btrfs and XFS with reflinks enabled are tested.

The default store is `<source>/.boot/sessions`, keeping seeds and sessions on the
same volume. `--store <path>` selects another private store. The global registry
at `BOOT_HOME/session-stores.json` (normally `~/.boot`) contains store paths only.
APFS clones cannot cross volumes, and Linux reflinks cannot cross filesystems.
Initial committed seeds are ordinary Git clones on the destination filesystem;
subsequent CoW sessions share their data blocks. Prepared artifacts must also be
cloneable from their source into that store. Initial seed cost is included in the
benchmark results.

Default contents are committed files at the recorded commit IDs. Create reports
excluded tracked and untracked source changes. To preserve current staged,
unstaged, and untracked state explicitly:

```bash
boot session create . --name experiment --include-working-tree
```

This requires source HEAD to equal the selected commit. Staged and unstaged
patches remain distinct. Changes imported at creation stay protected by GC even
if an agent subsequently resets or removes them.

Prepared dependencies and build artifacts require an explicit include:

```bash
boot session create . --name prepared --storage cow --include node_modules dist
# For a workspace whose selected repository lives in apps/web:
boot session create . --name web --include apps/web/node_modules
```

Includes are relative to the workspace and must live inside a selected repository.
They cannot overlap committed files or each other. Only `cow` and `auto` support
this policy; unavailable CoW fails rather than dropping artifacts or copying them
silently. Every writable file has an independent inode; hard links and ordinary
writable directory links are never used to simulate CoW.

Prepared seed identities include the base commit and artifact metadata fingerprint.
Boot checks for source changes around copying and rejects observed concurrent
modifications. Stop build/install processes before capturing prepared files:
per-file cloning and metadata checks do not provide an atomic multi-file or
multi-repository snapshot against arbitrary concurrent writers. Seeds are published
by atomic rename. `.boot` is reserved for Boot state and excluded from snapshots.

Relative symlinks contained within the snapshot are supported. Absolute or
escaping links are rejected. Environments with absolute shebangs, embedded paths,
external package stores, native dependencies for another platform, or build caches
keyed by the original path may need preparation again after relocation. No claim
is made that every dependency tree is relocatable. Live database files, sockets,
and device nodes are unsuitable artifacts; database consistency requires a
database-aware backup. Direct `.db`/SQLite includes are rejected.

## Submodules

Initialized Git submodules are captured recursively at the commits pinned by each
parent. Every child has its own checkout, index, and managed Git storage; its
source `.git` pointer is never copied into a session. Inspection and GC include
all children, and `diff` reports each repository separately.

Boot does not fetch submodule URLs. Prepare the source first with
`git submodule update --init --recursive`. The pinned commits must exist locally.
Without `--include-working-tree`, a child checked out at another commit is reset
only in the new session to its parent's pinned commit. With that flag, Boot
captures the child's current HEAD, its staged/unstaged/untracked work, and the
parent's staged gitlink separately. That imported state remains protected by GC.
Commit submodule additions, removals, renames, and conflict resolutions before
capturing dirty state. Stop writers across all repositories during capture.

Prepared artifacts inside submodules use workspace-relative paths, for example
`--include plugins/lib/node_modules`. Including an entire submodule is rejected.
Selecting a parent repository and a separate nested repository in `boot.yaml`
remains unsupported; submodules are discovered through their parent's Git tree.

## Optional ports and PostgreSQL

Declare resources and select them in a profile:

```yaml
runtime:
  web:
    type: port
    env: PORT
  postgres:
    type: postgres
    version: "17"
    env: DATABASE_URL
profiles:
  agent:
    repositories: all
    runtime: [web, postgres]
```

```bash
boot session create . --profile agent --name fix --runtime
boot session run fix -- codex
# Project setup/migrations are explicit and receive the same runtime variables:
boot session run fix -- boot up --run-setup
```

`--runtime` is required; ordinary sessions allocate no resources. Profile
selection accepts `all` or resource ID lists, like other Boot selections. Ports
alone need no Docker. PostgreSQL supports versions `16` and `17` (default `17`)
using the official Alpine image, with local Docker Engine 28+ on macOS/Linux.
The Docker context must use a local Unix socket. Boot may pull the selected image.

Each session gets its own Docker network, with separate containers and named
data volumes for its databases. Databases start empty. Boot publishes it only on `127.0.0.1` and generates a random password.
The database is named `boot` with user `boot`; the connection URL is delivered in
the configured variable. A matching PostgreSQL `services` entry with the same ID
is omitted from the session's frozen definition so setup does not start or probe
a shared database. Other services retain their existing behavior.

At each `run`, Boot starts stopped databases, waits for PostgreSQL readiness, and
supplies all selected runtime variables to the child. They override inherited or
stored values of the same names. Runtime passwords use Boot's encrypted storage
outside the Git workspace; inspection exposes only resource state, environment
names, and port numbers. Keep the existing Boot key available for later launches.
`claim` tracks an external owner; it does not supply runtime variables. Launch
through `run` when the agent or its children need these resources.

App and database ports share a locked allocation registry under `BOOT_HOME`.
Assignments stay with the session until GC, including while released. Apps must
honor the configured variable, for example `PORT`; Boot does not rewrite app
configuration. These are cooperative leases among Boot sessions using the same
`BOOT_HOME`, not permanent socket reservations. Launch refuses an already occupied
app port, but unrelated processes can still race to bind it. Services not declared
as managed resources remain shared and need separate configuration.

Release stops owned databases and preserves their volumes. A later run restarts
them with their data. **GC deletes these disposable database volumes when it
removes an eligible session, including data written during tests.** Export any
results you need before applying cleanup. The GC preview lists the database
containers and volumes selected for removal. GC verifies the original daemon and
ownership labels even with `--discard-work`; a foreign/replaced resource is
retained. Failed provisioning leaves a recovery record. Review it and use the
exact-session discard workflow to remove partially created resources.

See the official [Docker port publishing documentation](https://docs.docker.com/engine/network/port-publishing/)
for the Engine 28 loopback requirement and the [PostgreSQL image documentation](https://hub.docker.com/_/postgres)
for database initialization and volume behavior.

## Agent execution and ownership

`run` starts the executable directly with the session root as cwd. Arguments after
`--` retain their boundaries. It forwards SIGINT/SIGTERM/SIGHUP to the process group
on POSIX, records the exit result, and preserves CLI exit/signal semantics.

The child receives nonsecret `BOOT_SESSION_ID`, `BOOT_SESSION_ROOT`,
`BOOT_SESSION_STORE`, and `BOOT_SESSION_SOURCE`. `boot inspect --json` additionally
reports session identity, base commits, and actual storage. The resolved profile
is frozen in session metadata; source `boot.yaml` changes do not expand an existing
session. Boot does not overwrite a committed `boot.yaml` in a root repository.

Selected encrypted Boot values are delivered at launch using the source
workspace's existing encrypted environment mechanism, without copying its key or
credential files. Values with conflicting repository scopes are rejected for a
single root process. Existing process environment inheritance is unchanged;
Boot's selection controls the additional values it delivers. Inspection contains
names/availability only, and arbitrary health-check output is suppressed.

For an IDE or agent started outside `run`, explicitly claim ownership before
starting it, then release using the same nonsecret label after it stops:

```bash
boot session claim fix --owner editor
# Open the reported root in the editor and complete the task.
boot session release fix --owner editor
```

Claims do not expire based on age. A launched command and its process-group
descendants protect the session. If the launcher crashes, the reservation remains
protected even if its PID was never recorded. After verifying all processes have
stopped, use `release --acknowledge-stopped`. PID reuse causes conservative
retention. A process that deliberately escapes its group requires external
ownership handling; Boot is not a hostile-process sandbox.

## Inspection and cleanup

`list --json` and `inspect --json` expose state, timestamps, owner, source,
per-repository base/head, tracked changes, untracked/ignored files, outstanding
commits, files created alongside repositories, and explicit protection reasons.
`diff` shows the tracked diff against the immutable base, a separate staged
diff, untracked names, and outstanding commit IDs.

Release marks a session inactive, stops owned databases, and keeps files and database data. GC previews by default;
`--apply` rechecks under a cross-process lock. It retains active sessions, tracked
changes, untracked files, ignored files outside declared artifacts, changed
artifacts, imported work, stashes/reflog commits, in-progress Git operations, and
unverifiable state. The base must still be reachable from a source ref.

Publication and integration of new commits are not inferred from stale remote
tracking refs. This first release conservatively retains every commit beyond the
base, including externally merged/pushed commits, until the operator explicitly
discards that session after verifying the retained work. Shared worktree refs can
protect multiple sessions. No remote fetch is required for inspection or GC.

Destructive overrides must select one exact full session ID:

```bash
boot session gc --session FULL-UUID --discard-work FULL-UUID
boot session gc --session FULL-UUID --discard-work FULL-UUID --apply
```

The override cannot bypass active ownership, private-store ownership, matching
ownership markers, or physical path containment. Unknown/corrupt metadata and
symlink substitutions block deletion. Interrupted provisioning without a workspace
can be reclaimed automatically. Partial workspaces are retained for review and
require the same explicit discard. Only resources journaled to that attempt are
removed; shared seeds remain while referenced. Unused owned seeds are reclaimed
with their last session.

## Guarantees and compatibility

Filesystem isolation does not isolate external services or other same-user
processes. Optional runtime resources provide cooperative port assignments and
separate disposable PostgreSQL databases; they are not an OS sandbox. `readOnly` remains an agent intent; the local
provider does not enforce OS access restrictions. Writable session creation
requires a writable profile. Use the agent's sandbox or a separate execution
environment for enforcement.

Session JSON and registry files begin at schema version 1. Existing non-session
`boot inspect` JSON retains its shape/version. A session adds the optional
`session` object to that v1 contract; strict consumers must accept this documented
extension before inspecting new managed sessions. Optional submodule ancestry and
runtime fields extend this contract and session records. New CLIs read old
sessions; older strict CLIs cannot read sessions containing these new fields.
Do not downgrade while such sessions exist. Existing bootstrap commands,
maps, context files, and their versions are unchanged.

Nested/overlapping selected repositories, remote workspace providers,
and whole-volume snapshots are not supported by this session release. Windows
native CoW and Job Object execution are implemented, with native Windows
validation pending as described below. macOS/Linux checks remain passing.

## Windows sessions

The Windows implementation targets Windows x64 with the built-in .NET Framework
4.8 compiler. Boot compiles its small helper once into a private cache; neither
Visual Studio nor a third-party filesystem driver is needed. It checks the
current user's SID and directory ACLs before accessing a store. Windows records
created without a verified SID remain protected for manual recovery.

ReFS cloning requires source and destination files on the same local ReFS volume.
It uses aligned block-clone requests (including partial final clusters) with no
ordinary-copy fallback. Named alternate streams and reparse points are rejected
instead of being silently dropped or followed. Prepared artifacts on an NTFS
source cannot be cloned into a ReFS store; prepare those artifacts on ReFS first.
See [Microsoft's block cloning contract](https://learn.microsoft.com/en-us/windows/win32/fileio/block-cloning).

Execution uses a Windows Job Object. The agent is created suspended with
atomic job membership, then resumed only after the helper's identity has been recorded. The
launcher waits for descendants even after the original command exits. If Boot or
the helper is killed, the job stops its processes. Interrupted launch metadata
still requires `release --acknowledge-stopped` before cleanup.

Ctrl+C/SIGINT, SIGTERM and SIGHUP received by Boot request CTRL+BREAK for the
agent's console group, then terminate the job after a two-second grace period.
This is Windows cancellation behavior, not POSIX signal emulation. The original
command's exit code is preserved after its job completes. Common npm/pnpm Node
`.cmd` shims are resolved to their JavaScript entrypoints without invoking a
shell. Other batch wrappers need an explicit executable or `node <entrypoint>`.
Job Objects are not a security boundary against processes launched through an
unrelated broker or service.

**Native Windows validation is pending.** The helper cross-compiles successfully,
but that does not establish Windows filesystem or process behavior. The prepared
Windows 2022/2025 CI suite exercises NTFS fallback, ReFS with 4 KiB and 64 KiB
clusters, process trees, interrupted launchers, arguments, and standalone builds.
The existing managed PostgreSQL runtime still requires macOS/Linux Docker.

## Reproducing validation

`pnpm test:sessions` runs real-filesystem session, process, and preparation tests.
`pnpm test:sessions:windows` requires a real Windows machine with permission to
create disposable VHDs; it tests NTFS plus ReFS 4K/64K volumes and detaches only
its own VHDs afterward.
The CoW test explicitly skips unsupported general test filesystems, while the
dedicated Linux suite sets `BOOT_TEST_REQUIRE_COW=1` and must succeed on real CoW.
`pnpm test:sessions:linux` creates disposable Btrfs and XFS images inside Docker;
mounting requires a privileged test container and the source is bound read-only.
It also verifies real unsupported tmpfs behavior. `pnpm test:sessions:runtime`
runs opt-in tests against local Docker: two independent PostgreSQL databases,
authenticated SQL, launch variables, persistence, ownership refusal, and cleanup. `pnpm demo:sessions` runs the
installed Codex and Claude CLIs on disposable source, using their existing auth.

`pnpm benchmark:sessions` prepares the repository's actual installed dependencies
plus a 128 MiB edit payload on an isolated APFS disk image. It measures 1, 4, and
8 sessions, creation latency including the first seed, allocated volume blocks
before/after 1 MiB writes per session, and reclaimed storage. Clean
unmount/remount cycles commit APFS delayed allocations before measurement. Shared
blocks are counted once by filesystem allocation, not summed directory sizes.
Results are written to `docs/session-benchmark-results.json`.
