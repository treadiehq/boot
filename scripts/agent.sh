#!/usr/bin/env bash
#
# Install Boot when needed, then prepare a cloud-agent workspace.
#
#   curl -fsSL https://useboot.co/agent.sh | bash -s -- \
#     git@github.com:acme/map.git /workspace --profile agent
#
# Environment overrides:
#   BOOT_BIN          existing Boot executable to use
#   BOOT_BIN_DIR      installation directory when Boot is missing
#   BOOT_INSTALL_URL  installer URL
#   BOOT_VERSION      release tag to install, e.g. v0.3.6
#   BOOT_FORCE_INSTALL=1  install even when Boot is already on PATH
#
set -euo pipefail

usage() {
  printf '%s\n' \
    "Usage: agent.sh <workspace-map> <workspace-path> [boot agent options]" \
    "" \
    "Example:" \
    "  curl -fsSL https://useboot.co/agent.sh | bash -s -- \\" \
    "    git@github.com:acme/map.git /workspace --profile agent"
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

resolve_explicit_boot() {
  local requested="$1"
  if [[ "$requested" == */* ]]; then
    [[ -x "$requested" ]] || die "BOOT_BIN is not executable: $requested"
    printf '%s\n' "$requested"
    return
  fi

  local resolved
  resolved="$(command -v "$requested" 2>/dev/null || true)"
  [[ -n "$resolved" ]] || die "BOOT_BIN was not found on PATH: $requested"
  printf '%s\n' "$resolved"
}

install_boot() {
  command -v curl >/dev/null 2>&1 ||
    die "curl is required to install Boot. Install curl, then retry."

  local bin_dir
  if [[ -n "${BOOT_BIN_DIR:-}" ]]; then
    bin_dir="$BOOT_BIN_DIR"
  elif [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
    bin_dir="/usr/local/bin"
  else
    bin_dir="$HOME/.local/bin"
  fi

  local install_url="${BOOT_INSTALL_URL:-https://useboot.co/install.sh}"
  printf 'Installing Boot from %s\n' "$install_url" >&2
  curl -fsSL "$install_url" | BOOT_BIN_DIR="$bin_dir" bash >&2

  local installed="$bin_dir/boot"
  [[ -x "$installed" ]] ||
    die "Boot installation completed without creating an executable at $installed"
  printf '%s\n' "$installed"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if (( $# < 2 )); then
  usage >&2
  die "workspace map and workspace path are required."
fi

remote="$1"
workspace="$2"
shift 2

[[ -n "$remote" ]] || die "workspace map cannot be empty."
[[ -n "$workspace" ]] || die "workspace path cannot be empty."
command -v git >/dev/null 2>&1 ||
  die "git is required. Install Git, authenticate to the workspace repositories, then retry."

if [[ -n "${BOOT_BIN:-}" ]]; then
  boot_bin="$(resolve_explicit_boot "$BOOT_BIN")"
elif [[ "${BOOT_FORCE_INSTALL:-0}" != "1" && -z "${BOOT_VERSION:-}" ]] &&
  command -v boot >/dev/null 2>&1; then
  boot_bin="$(command -v boot)"
else
  boot_bin="$(install_boot)"
fi

"$boot_bin" --version >/dev/null 2>&1 ||
  die "The Boot executable could not run: $boot_bin"

agent_options=("$@")
has_run_setup=false
has_json=false
for option in "${agent_options[@]}"; do
  [[ "$option" == "--run-setup" ]] && has_run_setup=true
  [[ "$option" == "--json" ]] && has_json=true
done

$has_run_setup || agent_options+=("--run-setup")
$has_json || agent_options+=("--json")

# Keep stdout machine-readable: installer progress and wrapper errors use stderr,
# while `boot agent --json` owns stdout and includes the inspect diagnostics.
exec "$boot_bin" agent "$remote" "$workspace" "${agent_options[@]}"
