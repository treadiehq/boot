#!/usr/bin/env bash
#
# Download the boot binary and install it on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.sh | bash
#
# Environment overrides:
#   BOOT_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
#   BOOT_BIN_DIR   where to install the `boot` binary
#                  (default: /usr/local/bin if writable, else ~/.local/bin)
#   BOOT_REPO      owner/repo to download releases from (default: treadiehq/boot)
#
set -euo pipefail

REPO="${BOOT_REPO:-treadiehq/boot}"
VERSION="${BOOT_VERSION:-latest}"
BIN_NAME="boot"

if [ -t 1 ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); green=$(printf '\033[32m')
  red=$(printf '\033[31m'); reset=$(printf '\033[0m')
else
  bold=""; dim=""; green=""; red=""; reset=""
fi
say()  { printf '%s\n' "${dim}→${reset} $*"; }
ok()   { printf '%s\n' "${green}✓${reset} $*"; }
die()  { printf '%s\n' "${red}✗${reset} $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH."; }

need curl

# --- detect platform ---------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "this is the Unix installer. On Windows, install with PowerShell:
  irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex" ;;
  *) die "unsupported OS: $OS (boot supports Linux, macOS, and Windows)" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported architecture: $ARCH (boot supports x64 and arm64)" ;;
esac

ASSET="${BIN_NAME}-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

# --- pick an install dir (no sudo) -------------------------------------------
if [ -n "${BOOT_BIN_DIR:-}" ]; then
  BIN_DIR="$BOOT_BIN_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"

# --- download + install ------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading ${bold}${ASSET}${reset} (${VERSION})…"
if ! curl -fSL --progress-bar "$URL" -o "$TMP/$BIN_NAME"; then
  die "Could not download $URL
Check your network connection and available releases: https://github.com/${REPO}/releases"
fi

chmod +x "$TMP/$BIN_NAME"
mv -f "$TMP/$BIN_NAME" "$BIN_DIR/$BIN_NAME"

if ! "$BIN_DIR/$BIN_NAME" --version >/dev/null 2>&1; then
  die "The installed binary could not run: $BIN_DIR/$BIN_NAME"
fi
ok "Installed ${bold}boot $("$BIN_DIR/$BIN_NAME" --version)${reset} at $BIN_DIR/$BIN_NAME"

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n'
    shell_name="$(basename "${SHELL:-}")"
    say "Add ${bold}$BIN_DIR${reset} to your PATH:"
    case "$shell_name" in
      zsh)
        printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc && source ~/.zshrc\n' "$BIN_DIR"
        ;;
      bash)
        printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc && source ~/.bashrc\n' "$BIN_DIR"
        ;;
      fish)
        printf '    fish_add_path "%s"\n' "$BIN_DIR"
        ;;
      *)
        printf '    export PATH="%s:$PATH"\n' "$BIN_DIR"
        ;;
    esac
    ;;
esac

printf '\n'
ok "Boot is installed. Initialize a workspace with:"
printf '    %sboot init%s\n' "$bold" "$reset"
printf '\n'
printf '%sUpdate later:%s  boot update\n' "$dim" "$reset"
