#!/usr/bin/env bash
#
# A narrated, self-contained live demo of boot's core promise:
#
#   "A fresh machine gets your exact workspace in seconds — repos arrive as tiny
#    placeholders and hydrate into real clones the moment you open them."
#
# It fakes TWO machines on this one box using a local folder as the shared map
# (no GitHub, no network) and local bare git repos as remotes. Everything lives
# under a temp dir that is removed on exit, so your real filesystem is untouched.
#
# Run with:  pnpm demo            (press Enter to advance between beats)
#            pnpm demo -- -y      (auto-advance, no prompts — good for recording)
#            pnpm demo -- --keep  (keep the temp workspace to poke around after)
#
set -euo pipefail

# --- Options ---------------------------------------------------------------
PAUSE=1      # wait for Enter between beats
BUILD=1      # rebuild the CLI first
KEEP=0       # keep the temp dir on exit
for arg in "$@"; do
  case "$arg" in
    -y|--yes|--no-pause) PAUSE=0 ;;
    --no-build)          BUILD=0 ;;
    --keep)              KEEP=1 ;;
    -h|--help)
      sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
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
[ -f "$DIST" ] || { echo "FATAL: $DIST not found — run without --no-build." >&2; exit 1; }
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
printf '%s\n' "$(c bold 'boot — Dropbox for ~/code')"
say "It syncs the *map* of your workspace, not the files. A fresh machine gets"
say "your whole layout in seconds; repos hydrate into real clones on first open."
say ""
say "This demo fakes two machines on one box — a local folder is the shared map,"
say "local git repos stand in for your GitHub remotes. Nothing leaves this laptop."
pause

# --- Beat 1: Laptop A has a real workspace ---------------------------------
step "Laptop A — a normal ~/code with three git repos"
say "Setting up apps/web, apps/api and libs/ui (each with a remote)…"
mkrepo laptop-A/code/apps/web remotes/web.git >/dev/null 2>&1
mkrepo laptop-A/code/apps/api remotes/api.git >/dev/null 2>&1
mkrepo laptop-A/code/libs/ui  remotes/ui.git  >/dev/null 2>&1
export BOOT_HOME="$WORK/home-A"   # isolates "machine A" config under the temp dir
run boot status laptop-A/code
pause

# --- Beat 2: publish the map -----------------------------------------------
step "Laptop A — publish the workspace map"
say "link records the shape into the shared folder; push keeps it current."
run boot link dropbox/boot-map laptop-A/code --folder
run boot push laptop-A/code
pause

# --- Beat 3: a brand-new machine ------------------------------------------
step "Laptop B — a brand-new machine links the same map"
export BOOT_HOME="$WORK/home-B"   # a *different* machine, fresh config
run boot link dropbox/boot-map laptop-B/code --folder
say ""
say "The entire workspace exists already — but it's just placeholders:"
run du -sh laptop-B/code
run boot status laptop-B/code
pause

# --- Beat 4: the magic — hydrate on open -----------------------------------
step "Laptop B — open one repo and it hydrates itself"
say "'boot enter' is what the shell hook runs when you cd into a folder."
run boot enter laptop-B/code/apps/api
say ""
say "apps/api is now a real clone — the others are still weightless placeholders:"
run boot status laptop-B/code
pause

# --- Outro -----------------------------------------------------------------
step "That's it"
say "On two real machines this is a single command per box:"
printf '   %s\n' "$(c cyan 'boot setup git@github.com:you/your-code-map.git ~/code')"
say "…then just cd into a repo and the shell hook hydrates it on access."
printf '\n%s\n' "$(c green '✓ demo complete')"
