#!/usr/bin/env bash
#
# Manual QA for core CLI workflows.
#
# Creates a fully self-contained temporary workspace with local Git repos
# (no network, no GitHub), then exercises key commands and checks their
# expected behavior. Temporary workspaces are removed on exit; the build step
# updates this project's dist/ directory.
#
# Run with:  pnpm qa
#
set -euo pipefail

# --- Locate the project and the compiled CLI -------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "FATAL: git is required for the QA script but was not found on PATH." >&2
  exit 1
fi

echo "Building the CLI..."
pnpm build >/dev/null 2>&1 || { echo "FATAL: build failed" >&2; exit 1; }
DIST="$PROJECT_ROOT/dist/index.js"
[ -f "$DIST" ] || { echo "FATAL: build did not create $DIST" >&2; exit 1; }
boot() { node "$DIST" "$@"; }

# --- Scratch space ----------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-qa.XXXXXX")"
OUT="$WORK/.last-output.txt"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

WS="$WORK/workspace"
EAGER="$WORK/restore-eager"
LAZY="$WORK/restore-lazy"
MANIFEST="$WORK/manifest.json"
REMOTE_A="$WORK/remote-a.git"
REMOTE_C="$WORK/remote-c.git"
mkdir -p "$WS"

# --- Pass/fail bookkeeping (careful: must not trip `set -e`) ----------------
PASS=0
FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

assert_file()      { if [ -e "$1" ]; then ok "exists: ${1#$WORK/}"; else bad "missing: ${1#$WORK/}"; fi; }
refute_file()      { if [ ! -e "$1" ]; then ok "absent: ${1#$WORK/}"; else bad "should be absent: ${1#$WORK/}"; fi; }
assert_in_file()   { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3 (missing '$2')"; fi; }
refute_in_file()   { if grep -qF -- "$2" "$1"; then bad "$3 (unexpected '$2')"; else ok "$3"; fi; }
assert_out()       { if grep -qF -- "$1" "$OUT"; then ok "$2"; else bad "$2 (missing '$1')"; fi; }

# Helper: make a committed local git repo with a default branch.
mkrepo() { # <dir> <branch>
  local dir="$1" branch="$2"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" symbolic-ref HEAD "refs/heads/$branch"
  git -C "$dir" config user.email qa@example.com
  git -C "$dir" config user.name "QA Bot"
}

echo
echo "=== Setting up a temp workspace at $WS ==="

# repo-a: node + pnpm, has a remote, clean. node_modules/.next present but gitignored.
REPO_A="$WS/apps/repo-a"
mkrepo "$REPO_A" main
printf '{"name":"repo-a"}\n' > "$REPO_A/package.json"
: > "$REPO_A/pnpm-lock.yaml"
printf 'node_modules/\n.next/\n' > "$REPO_A/.gitignore"
mkdir -p "$REPO_A/node_modules/left-pad" "$REPO_A/.next"
git -C "$REPO_A" add -A
git -C "$REPO_A" commit -q -m "init repo-a"
git init -q --bare "$REMOTE_A"
git -C "$REPO_A" remote add origin "$REMOTE_A"
git -C "$REPO_A" push -q origin main

# repo-c: has a remote, dirty (uncommitted change).
REPO_C="$WS/libs/repo-c"
mkrepo "$REPO_C" main
printf 'package main\n' > "$REPO_C/main.go"
git -C "$REPO_C" add -A
git -C "$REPO_C" commit -q -m "init repo-c"
git init -q --bare "$REMOTE_C"
git -C "$REPO_C" remote add origin "$REMOTE_C"
git -C "$REPO_C" push -q origin main
printf 'dirty\n' > "$REPO_C/uncommitted.txt"   # leaves repo-c dirty

# repo-b: NO remote, on a non-default branch.
REPO_B="$WS/old/repo-b"
mkrepo "$REPO_B" feature
printf 'print("hi")\n' > "$REPO_B/app.py"
git -C "$REPO_B" add -A
git -C "$REPO_B" commit -q -m "init repo-b"

# A generated folder at the workspace root that hides a repo (must be skipped).
mkdir -p "$WS/node_modules/ghost/.git"
# A plain folder with no repo and no placeholder.
mkdir -p "$WS/scratch"

# --- 1. init ---------------------------------------------------------------
echo
echo "=== init ==="
boot init "$WS" | tee "$OUT"
# init writes a dot-ignore file and a yaml config (name-agnostic discovery).
IGNORE_FILE="$(find "$WS" -maxdepth 1 -name '.*ignore' | head -n1)"
CONFIG_FILE="$(find "$WS" -maxdepth 1 -name '*.yaml' | head -n1)"
[ -n "$IGNORE_FILE" ] && ok "init created an ignore file ($(basename "$IGNORE_FILE"))" || bad "init created an ignore file"
[ -n "$CONFIG_FILE" ] && ok "init created a yaml config ($(basename "$CONFIG_FILE"))" || bad "init created a yaml config"
# init must not overwrite without --force.
printf 'sentinel\n' > "$IGNORE_FILE"
boot init "$WS" >/dev/null
assert_in_file "$IGNORE_FILE" "sentinel" "init does not overwrite without --force"
boot init "$WS" --force >/dev/null
refute_in_file "$IGNORE_FILE" "sentinel" "init --force overwrites"
assert_in_file "$CONFIG_FILE" 'schemaVersion: 1' "init writes a versioned workspace"
assert_in_file "$CONFIG_FILE" 'profiles:' "init writes profile definitions"

# --- workspace preparation and agent context -------------------------------
echo
echo "=== up / inspect ==="
boot up "$WS" --profile local --dry-run --json | tee "$OUT"
assert_out '"provider": "local"' "up dry-run prepares the local workspace"
assert_out '"profile": "local"' "up dry-run resolves the local profile"
boot up "$WS" --profile local --json | tee "$OUT"
assert_out '"ready": true' "up reaches a ready state"
boot inspect "$WS" --json | tee "$OUT"
assert_out '"repositories"' "inspect returns repository context"
assert_out '"constraints"' "inspect returns workspace constraints"

# --- 2. scan ---------------------------------------------------------------
echo
echo "=== scan ==="
boot scan "$WS" --output "$MANIFEST" | tee "$OUT"
assert_file "$MANIFEST"
assert_in_file "$MANIFEST" '"version": "0.2"' "manifest is version 0.2"
assert_in_file "$MANIFEST" '"ignoreFiles"' "manifest includes config.ignoreFiles"
assert_in_file "$MANIFEST" '"defaultIgnoreRules"' "manifest includes config.defaultIgnoreRules"
assert_in_file "$MANIFEST" '"hydrate"' "manifest includes repo hydration metadata"
assert_in_file "$MANIFEST" 'apps/repo-a' "scan found apps/repo-a"
assert_in_file "$MANIFEST" 'old/repo-b' "scan found old/repo-b"
refute_in_file "$MANIFEST" 'ghost' "scan skipped repo hidden in node_modules"

# --- 3. list ---------------------------------------------------------------
echo
echo "=== list ==="
boot list "$MANIFEST" | tee "$OUT"
assert_out "repo-a" "list shows repo-a"
assert_out "repo-b" "list shows repo-b"
assert_out "repo-c" "list shows repo-c"

# --- 4. eager restore ------------------------------------------------------
echo
echo "=== restore (eager) ==="
boot restore "$MANIFEST" "$EAGER" | tee "$OUT"
assert_file "$EAGER/apps/repo-a/.git"          # cloned a real repo
assert_file "$EAGER/old/repo-b"                # folder created
refute_file "$EAGER/old/repo-b/.git"           # but not cloned (no remote)
assert_out "no remote" "eager restore warns about the remoteless repo"

# --- 5. lazy restore -------------------------------------------------------
echo
echo "=== restore --lazy ==="
boot restore "$MANIFEST" "$LAZY" --lazy | tee "$OUT"
REPO_JSON_A="$(find "$LAZY/apps/repo-a" -name repo.json | head -n1)"
[ -n "$REPO_JSON_A" ] && ok "lazy restore wrote placeholder metadata for repo-a" || bad "lazy restore wrote placeholder metadata for repo-a"
assert_in_file "$REPO_JSON_A" '"hydrateStatus": "placeholder"' "placeholder marked as placeholder"
assert_in_file "$REPO_JSON_A" "$REMOTE_A" "placeholder records the remote URL"
refute_file "$LAZY/apps/repo-a/.git"           # not cloned yet
# remoteless repo placeholder must record a null remote.
REPO_JSON_B="$(find "$LAZY/old/repo-b" -name repo.json | head -n1)"
assert_in_file "$REPO_JSON_B" '"remoteUrl": null' "remoteless placeholder records null remote"
assert_out "cannot clone it" "lazy restore explains why the repository cannot be cloned"

# --- 6. status -------------------------------------------------------------
echo
echo "=== status (before hydrate) ==="
boot status "$LAZY" | tee "$OUT"
assert_out "Repository placeholders:" "status lists repository placeholders"
assert_out "apps/repo-a" "status shows repo-a placeholder"
assert_out "old/repo-b" "status shows repo-b placeholder"

# --- 7. hydrate ------------------------------------------------------------
echo
echo "=== hydrate ==="
boot hydrate "$LAZY/apps/repo-a" | tee "$OUT"
assert_file "$LAZY/apps/repo-a/.git"           # now cloned
assert_file "$LAZY/apps/repo-a/package.json"   # real content present
assert_in_file "$REPO_JSON_A" '"hydrateStatus": "hydrated"' "hydrate updates status to hydrated"
# hydrated repo must be clean (placeholder dir excluded from git).
if [ -z "$(git -C "$LAZY/apps/repo-a" status --porcelain)" ]; then
  ok "hydrated repo is clean"
else
  bad "hydrated repo is clean"
fi
# hydrate is idempotent / refuses to overwrite a real repo.
boot hydrate "$LAZY/apps/repo-a" | tee "$OUT"
assert_out "already cloned" "hydrate refuses to overwrite an existing repository"
# hydrate refuses a remoteless placeholder.
if boot hydrate "$LAZY/old/repo-b" >"$OUT" 2>&1; then
  bad "hydrate should fail for a remoteless placeholder"
else
  ok "hydrate fails for a remoteless placeholder"
fi
assert_file "$REPO_JSON_B"                      # placeholder left intact

# --- 8. doctor -------------------------------------------------------------
echo
echo "=== doctor ==="
boot doctor "$LAZY" | tee "$OUT"
assert_out "placeholder with no remote URL" "doctor flags the repository that cannot be downloaded"
assert_out "Warnings:" "doctor prints a warnings section"
boot doctor "$WS" | tee "$OUT"
assert_out "dirty" "doctor flags the dirty repo in the source workspace"

# --- Summary ---------------------------------------------------------------
echo
echo "==================================================="
echo "QA RESULTS:  $PASS passed, $FAIL failed"
echo "==================================================="
if [ "$FAIL" -ne 0 ]; then
  echo "QA FAILED"
  exit 1
fi
echo "QA PASSED — core workflows verified."
