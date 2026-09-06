# Managed session validation

Validated locally on 2026-09-06. The feature, fixtures, measurement scripts, and
documentation are in the working changes; these results do not represent a
published release or a deployed website.

## Preparation regressions

Six executable regressions reproduced failures on the original HEAD before the
fixes: setup after a repository conflict, symlinked repository parents, successful
health-check output leaking a synthetic value, tag/SHA readiness, dry-run registry
writes and manifest probes, and the `>=18 <20` version range accepting Node 24.
All now pass in `src/tests/preparationRegressions.test.ts`. The dry-run regression
also verifies that Git inspection leaves index bytes unchanged.

The seventh issue was a policy distinction: `readOnly` is agent intent and does
not enforce OS permissions. That boundary is now explicit in CLI errors, the
workspace/session/provider documentation, and the website. Session creation
requires a writable profile.

## Automated and live checks

The final command outcomes are below. Tests use
disposable source repositories and synthetic values, never production secrets.

- `pnpm test:sessions`: 39 passed, 1 Linux-only skip on macOS/APFS.
- `pnpm test:run`: 73 files passed; 524 tests passed. PostgreSQL tests are opt-in;
  the Linux-only tmpfs case and eight native Windows tests are skipped on macOS.
- `pnpm test:sessions:runtime`: 4 passed against real local Docker/PostgreSQL 16/17.
- `pnpm test:sessions:linux`: 38 passed on real Btrfs and 38 passed on real XFS,
  with the unsupported tmpfs case exercised in both runs.
- `pnpm lint`: passed TypeScript checking.
- `pnpm build`: passed ESM, CJS, and declaration builds. Existing CJS
  `import.meta` warnings remain in mount/service/UI/update commands.
- `pnpm demo:sessions`: both installed agents exited 0 using real APFS sessions.
- `pnpm benchmark:sessions`: completed the isolated-volume measurements below.
- Website `yarn dev`: `/sessions` compiled successfully after the runtime and
  submodule copy updates, with a 200 response in dev-server output. Colored CLI
  and YAML examples are preserved. Source is in `boot-website`. This follow-up
  did not repeat a visual browser review.

Session tests verify independent edits, staging, commits, and included dependency
writes; Boot-owned shared Git storage with separate indexes; linked-worktree
sources; explicit CoW failure and disclosed auto fallback; separate staged and
unstaged imports; frozen multi-repository profiles; encrypted selected-value
delivery; external ownership; active-process protection; exact argv, cwd, and
exit behavior; early SIGTERM while launch metadata is being saved; concurrent
CLI processes; actually killed provisioning; and interrupted deletion recovery.

GC tests cover staged work even when working files match HEAD, root-level notes
beside repositories, untracked work, stashes, new commits, missing source state,
imported work after reset, and symlink substitution. Inspection also fingerprints
prepared files and protects ignored files outside declared artifacts.
Imported symlinks are checked again after applying patches.

macOS uses the actual clonefile helper, including compilation and signature
verification of both arm64/x64 release helpers and execution of arm64 embedded
bytes. The dedicated Linux test runs inside a disposable privileged Docker
container with real Btrfs and XFS loop filesystems. It requires native CoW to
succeed and separately proves tmpfs refusal without mocks. CI now includes both
macOS/APFS and Linux filesystem jobs; CI itself has not been dispatched here.

The [live agent result](session-agent-demo-results.json) records Codex CLI
0.153.3 and Claude Code 2.1.261. Both wrote the requested fixture files, reported
cwd and Git root equal to their Boot session, left Git worktree registrations
unchanged, and had their work protected by GC. Source remained unchanged.
The example then released and explicitly discarded only its disposable sessions.

## Submodules and managed runtimes

Recursive submodule fixtures pass on APFS, Btrfs, and XFS across CoW, worktree,
and ordinary clone storage. They verify independent child edits/indexes, pinned
commits, separate parent gitlink staging and child HEAD, staged/unstaged/untracked
imports, prepared child artifacts, refusal of uninitialized sources or dirty
topology changes, and removal of child registrations before parent cleanup.

Port tests verify distinct allocations across two stores, delivery at launch,
occupied-port refusal, lease recovery, inspection availability, and GC release.
PostgreSQL tests use real containers with authenticated SQL and verify:

- Two concurrently launched processes connect to their assigned database ports
  and bind separate app ports; all four assignments are distinct.
- Each database holds different test data and cannot see the other's tables.
- Runtime variables override inherited values and replace the selected shared
  PostgreSQL service; passwords/URLs stay out of records and inspection.
- Release stops the database, restart preserves data, and GC previews its owned
  volume before deleting it without affecting the other session.
- PostgreSQL 16 and 17 both initialize and execute authenticated SQL.
- A different daemon or a foreign replacement prevents cleanup even with an
  exact-session discard. Partially created resources can be recovered when the
  container ID was never journaled.

An initial Docker test exposed that an internal bridge did not publish the port;
the implementation now uses a dedicated normal bridge with explicit localhost
publishing. A teardown timeout was corrected, and the orphaned test resources
were removed after verifying their exact ownership labels. The full-suite
multi-repository fixture exceeded its former five-second limit under concurrent
load; it now has a fifteen-second limit and passes. PostgreSQL CI coverage is
configured but has not been dispatched here.

## Physical storage benchmark

Environment: macOS arm64, Node v22.23.1, native APFS clonefile. The prepared project
uses Boot's actual installed dependency tree plus a 128 MiB incompressible edit
payload: 832,559,925 bytes (793.991 MiB) across 27,491 regular files. Its relocated
YAML dependency was loaded successfully. Preparing this source took 21.682 s;
that one-time source setup precedes the per-experiment baseline.

Each experiment uses a fresh store and includes first-seed creation. Physical
growth is allocated blocks on a dedicated 8 GiB APFS image. Clean unmount/remount
cycles commit delayed allocation/free transactions before every reading. Shared
blocks are counted once; directory-size sums are not used. Each session then
overwrites 1 MiB of the prepared payload before release and explicit discard.

| Sessions | Total creation | First / subsequent session | Physical growth after creation | Growth from edits | Reclaimed by GC | Retained overhead |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 12.813 s | 12.813 s / — | 23.781 MiB | 1 MiB | 24.777 MiB | 4 KiB |
| 4 | 32.539 s | 12.951 s / 6.462–6.589 s | 59.426 MiB | 4 MiB | 63.293 MiB | 136 KiB |
| 8 | 62.825 s | 13.497 s / 6.490–8.010 s | 107.508 MiB | 8 MiB | 115.367 MiB | 144 KiB |

These measurements and the paid-agent demo predate the submodule/runtime follow-up;
they were not repeated for it. Runtime resources were disabled.

[Raw measurements](session-benchmark-results.json) contain every session latency
and byte count. These are one local run, not latency guarantees or a Linux
performance benchmark. The remaining allocation is directory/metadata overhead;
session contents and unused seeds were reclaimed. The disposable image was
unmounted and removed afterward.

## Windows implementation follow-up

The ReFS helper compiles under Mono in the declared Linux test workflow, and
TypeScript checking passes. This is a compilation check, not Windows validation.
Native execution remains pending on Windows 2022/2025 runners. The new workflow
builds the standalone Windows binary and runs eight native tests plus one shim
parser test against NTFS, ReFS 4K, and ReFS 64K on disposable VHDs. It covers
strict CoW and partial clusters, independent files/indexes, exact argv/cwd/exit,
descendant protection, cancellation during journaling, supervisor death, junctions,
named streams, ownership SID checks, and standalone binary launches.

The macOS session regression suite and real Btrfs/XFS suite are rerun for this
change. The Windows validation warning must remain until the native runs pass.

## Limits

Windows ReFS cloning and Job Object execution are implemented but native Windows
validation is pending. NTFS cannot provide the ReFS block-cloning primitive.
Nested selected repositories, remote providers, and whole-volume snapshots are
unsupported. Submodules must be initialized locally; dirty topology changes
must be committed before capture. Source/npm APFS runs need Apple command line tools;
the macOS release workflow embeds signed helpers. x64 helpers were compiled and
signature-checked here, but runtime tests used arm64.

Prepared snapshots require stopped writers and relocatable files; they are not
atomic application/database snapshots. Runtime port assignments coordinate Boot
sessions sharing one BOOT_HOME; apps must use their provided variables, and
unrelated programs may still race for ports. Managed PostgreSQL requires local
Docker Engine 28+ and provides disposable per-session databases. Other external
services and hostile same-user processes remain outside Boot isolation. A process escaping
its group needs an external ownership claim. New commits remain conservatively
protected even after an external push/merge; discarding them requires a verified,
exact-session override. Unknown/corrupt ownership state requires manual review.

No implementation blocker remains in the validated macOS/Linux scope. Windows
validation, arbitrary service orchestration, and OS sandboxing are outside this
release's guarantees.
