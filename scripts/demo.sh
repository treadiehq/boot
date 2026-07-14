#!/usr/bin/env bash
#
# A self-contained demo of preparing a workspace for a coding agent.
#
# It creates a local authoring environment and a fresh coding-agent environment
# on one machine, using a local folder for shared workspace data
# (no GitHub, no network) and local bare git repos as remotes. Demo data lives
# under a temp directory; rebuilding the CLI also updates this project's dist/.
#
# Run with:  pnpm demo            (press Enter to advance between beats)
#            pnpm demo -y         (auto-advance, no prompts — good for recording)
#            pnpm demo --keep     (keep the temp workspace to poke around after)
#
set -euo pipefail

# --- Options ---------------------------------------------------------------
PAUSE=1      # wait for Enter between beats
BUILD=1      # rebuild the CLI first
KEEP=0       # keep the temp dir on exit
for arg in "$@"; do
  case "$arg" in
    --)                    ;;
    -y|--yes|--no-pause) PAUSE=0 ;;
    --no-build)          BUILD=0 ;;
    --keep)              KEEP=1 ;;
    -h|--help)
      sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- Pretty output (respects NO_COLOR / non-TTY) ---------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then USE_COLOR=1; else USE_COLOR=0; fi
c() { # <color> <text...>
  local code
  case "$1" in
    green) code=32 ;; red) code=31 ;; yellow) code=33 ;;
    cyan) code=36 ;; dim) code=2 ;; bold) code=1 ;; *) code=0 ;;
  esac
  shift
  if [ "$USE_COLOR" = 1 ]; then printf '\033[%sm%s\033[0m' "$code" "$*"; else printf '%s' "$*"; fi
}

say()  { printf '%s\n' "$(c dim "$*")"; }
step() { printf '\n%s\n' "$(c bold "════ $* ════")"; }
run()  { printf '\n%s %s\n' "$(c cyan '$')" "$(c bold "$*")"; "$@"; }
pause() {
  [ "$PAUSE" = 1 ] || return 0
  if [ -t 0 ]; then
    printf '\n%s' "$(c dim '   ↵  press Enter to continue…')"
    read -r _ || true
    printf '\n'
  fi
}

# --- Locate the project and (optionally) build the CLI ---------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

command -v git >/dev/null 2>&1 || { echo "FATAL: git is required for the demo." >&2; exit 1; }

if [ "$BUILD" = 1 ]; then
  say "Building the CLI (pnpm build)…"
  pnpm build >/dev/null 2>&1 || { echo "FATAL: build failed" >&2; exit 1; }
fi
DIST="$PROJECT_ROOT/dist/index.js"
[ -f "$DIST" ] || { echo "FATAL: $DIST not found. Run pnpm build, then retry." >&2; exit 1; }
boot() { node "$DIST" "$@"; }

# --- Scratch space (removed on exit unless --keep) -------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/boot-demo.XXXXXX")"
cleanup() {
  if [ "$KEEP" = 1 ]; then
    printf '\n%s\n' "$(c yellow "Kept demo workspace: $WORK")"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT
cd "$WORK"

# Build a committed local repo with a local bare "remote" to clone from.
mkrepo() { # <reldir> <relremote>
  mkdir -p "$1"
  git -C "$1" init -q -b main
  git -C "$1" config user.email demo@boot.dev
  git -C "$1" config user.name "boot demo"
  git -C "$1" config core.autocrlf false
  printf '# %s\n' "$(basename "$1")" > "$1/README.md"
  git -C "$1" add -A
  git -C "$1" commit -q -m "init $(basename "$1")"
  git init -q --bare "$2"
  git -C "$1" remote add origin "$PWD/$2"
  git -C "$1" push -q origin main
}

# ───────────────────────────────────────────────────────────────────────────
clear 2>/dev/null || true
printf '%s\n' "$(c bold 'boot — Give your agents a workspace')"
say "A coding agent starts without the project setup. This task needs three related repositories,"
say "their paths, documented commands, environment requirements, and constraints."
say ""
say "This demo fakes two environments on one box — a local folder is the shared map,"
say "local git repos stand in for your GitHub remotes. Nothing leaves this laptop."
pause

# --- Beat 1: describe the workspace ----------------------------------------
step "A developer describes a three-repository workspace"
say "Setting up apps/web, apps/api and libs/ui (each with a remote)…"
mkrepo laptop-A/code/apps/web remotes/web.git >/dev/null 2>&1
mkrepo laptop-A/code/apps/api remotes/api.git >/dev/null 2>&1
mkrepo laptop-A/code/libs/ui  remotes/ui.git  >/dev/null 2>&1
export BOOT_HOME="$WORK/home-A"   # isolates "machine A" config under the temp dir
export DEMO_BILLING_TOKEN="demo-secret-never-printed"
run boot init laptop-A/code
cat > laptop-A/code/boot.yaml <<EOF
schemaVersion: 1
workspace:
  id: demo/billing
  name: Billing
repositories:
  web:
    url: "$PWD/remotes/web.git"
    path: apps/web
    role: customer billing UI
    ref: main
  api:
    url: "$PWD/remotes/api.git"
    path: apps/api
    role: invoices and subscriptions API
    ref: main
  ui:
    url: "$PWD/remotes/ui.git"
    path: libs/ui
    role: shared interface components
    ref: main
commands:
  test:
    run: git status --short
    repository: api
env:
  required:
    - name: DEMO_BILLING_TOKEN
      secret: true
      source: process
constraints:
  - Never use production billing data
profiles:
  local:
    repositories: all
    hydrate: manual
  agent:
    repositories:
      - web
      - api
      - ui
    commands:
      - test
    env:
      - DEMO_BILLING_TOKEN
    hydrate: eager
defaults:
  profile: local
EOF
say "Added repository roles, an agent profile, a test command, and a constraint."
pause

# --- Beat 2: publish the workspace -----------------------------------------
step "Publish one workspace definition"
say "The shared folder carries boot.yaml and repository information."
run boot link dropbox/boot-map laptop-A/code --folder
run boot save laptop-A/code
pause

# --- Beat 3: a fresh agent environment ------------------------------------
step "A fresh coding-agent workspace starts with no project files"
export BOOT_HOME="$WORK/home-B"   # a *different* machine, fresh config
run boot link dropbox/boot-map laptop-B/code --folder
say ""
say "The repository information is present, but the agent profile has not been applied:"
run du -sh laptop-B/code
run boot status laptop-B/code
pause

# --- Beat 4: prepare and inspect -------------------------------------------
step "Prepare the agent workspace"
run boot up laptop-B/code --profile agent
say ""
say "The agent receives structured roles, paths, commands, and constraints:"
run boot inspect laptop-B/code --json
pause

# --- Outro -----------------------------------------------------------------
step "That's it"
say "The same definition can prepare local developer and coding-agent workspaces."
printf '   %s\n' "$(c cyan 'boot up /workspace --profile agent')"
printf '   %s\n' "$(c cyan 'boot inspect /workspace --json')"
printf '\n%s\n' "$(c green '✓ demo complete')"
