#!/usr/bin/env bash
#
# boot installer — one line per machine.
#
#   curl -fsSL https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh | bash
#
# Or, from a local checkout:
#
#   bash scripts/install.sh
#
# Environment overrides:
#   BOOT_REPO     git URL to clone when not run from a checkout
#                 (default: https://github.com/treadiehq/boot.git)
#   BOOT_REF      branch/tag/commit to install (default: main)
#   BOOT_APP_DIR  where to keep the built app (default: ~/.boot/app)
#   BOOT_BIN_DIR  where to symlink the `boot` binary (default: ~/.local/bin)
#
set -euo pipefail

BOOT_REPO="${BOOT_REPO:-https://github.com/treadiehq/boot.git}"
BOOT_REF="${BOOT_REF:-main}"
BOOT_APP_DIR="${BOOT_APP_DIR:-$HOME/.boot/app}"
BOOT_BIN_DIR="${BOOT_BIN_DIR:-$HOME/.local/bin}"

if [ -t 1 ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); green=$(printf '\033[32m')
  red=$(printf '\033[31m'); reset=$(printf '\033[0m')
else
  bold=""; dim=""; green=""; red=""; reset=""
fi
say()  { printf '%s\n' "${dim}→${reset} $*"; }
ok()   { printf '%s\n' "${green}✓${reset} $*"; }
die()  { printf '%s\n' "${red}✗${reset} $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# --- prerequisites -----------------------------------------------------------
need git
need node
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js >= 18 required (found $(node -v 2>/dev/null || echo none))."

# Prefer pnpm (the project's package manager) via corepack, then pnpm, then npm.
if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
elif command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  PM="$(command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npm)"
else
  PM="npm"
fi

# --- locate the source: local checkout, or clone -----------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd || true)"
SRC=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../package.json" ] && \
   grep -q '"name": "boot"' "$SCRIPT_DIR/../package.json" 2>/dev/null; then
  SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
  say "installing from local checkout: ${bold}$SRC${reset}"
else
  if [ -d "$BOOT_APP_DIR/.git" ]; then
    say "updating existing install in $BOOT_APP_DIR"
    git -C "$BOOT_APP_DIR" fetch --depth 1 origin "$BOOT_REF"
    git -C "$BOOT_APP_DIR" checkout -q FETCH_HEAD
  else
    say "cloning ${bold}$BOOT_REPO${reset} ($BOOT_REF) → $BOOT_APP_DIR"
    mkdir -p "$(dirname "$BOOT_APP_DIR")"
    git clone --depth 1 --branch "$BOOT_REF" "$BOOT_REPO" "$BOOT_APP_DIR"
  fi
  SRC="$BOOT_APP_DIR"
fi

# --- build -------------------------------------------------------------------
say "installing dependencies with $PM"
( cd "$SRC" && $PM install )
say "building"
( cd "$SRC" && $PM run build )

ENTRY="$SRC/dist/index.js"
[ -f "$ENTRY" ] || die "build did not produce $ENTRY"
chmod +x "$ENTRY" 2>/dev/null || true

# --- link onto PATH ----------------------------------------------------------
mkdir -p "$BOOT_BIN_DIR"
ln -sf "$ENTRY" "$BOOT_BIN_DIR/boot"
ok "linked ${bold}$BOOT_BIN_DIR/boot${reset} → $ENTRY"

if ! printf '%s' ":$PATH:" | grep -q ":$BOOT_BIN_DIR:"; then
  printf '\n'
  say "add $BOOT_BIN_DIR to your PATH, e.g.:"
  printf '    export PATH="%s:$PATH"\n' "$BOOT_BIN_DIR"
fi

printf '\n'
ok "boot installed. Get started with:"
printf '    boot setup <map-remote> ~/code\n'
