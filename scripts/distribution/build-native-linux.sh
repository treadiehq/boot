#!/usr/bin/env bash
#
# Build the same standalone Linux binary shape used by the release workflow,
# but only for the current runner architecture.
#
# Usage:
#   bash scripts/distribution/build-native-linux.sh [--output <path>]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT=""

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: build-native-linux.sh [--output <path>]

Build a standalone Boot binary for the current Linux architecture.

Options:
  --output <path>  Output path (default: dist/release/boot-linux-<arch>)
  -h, --help       Show this help
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --output)
      (( $# >= 2 )) || die "--output requires a path."
      OUTPUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1. Run with --help for usage."
      ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] ||
  die "this builder requires Linux. Use scripts/build-release.sh for cross-platform builds."

case "$(uname -m)" in
  x86_64|amd64)
    ARCH="x64"
    TARGET="bun-linux-x64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    TARGET="bun-linux-arm64"
    ;;
  *)
    die "unsupported Linux architecture: $(uname -m). Expected x86_64 or aarch64."
    ;;
esac

for command_name in bun node pnpm; do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "$command_name is required to build the standalone Linux binary."
done

if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$ROOT/dist/release/boot-linux-$ARCH"
elif [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$PWD/$OUTPUT"
fi

VERSION="$(node -p "require('$ROOT/package.json').version")"
[[ -n "$VERSION" ]] || die "could not read the version from package.json."

mkdir -p "$(dirname "$OUTPUT")"

restore_embedded_ui() {
  node "$ROOT/scripts/embed-ui.mjs" --reset >/dev/null
}
trap restore_embedded_ui EXIT

printf 'Building launchpad assets for the standalone binary\n'
(cd "$ROOT" && pnpm ui:build >/dev/null)
node "$ROOT/scripts/embed-ui.mjs" >/dev/null

printf 'Building Boot v%s for %s\n' "$VERSION" "$TARGET"
bun build "$ROOT/src/index.ts" \
  --compile \
  --target="$TARGET" \
  --outfile="$OUTPUT" \
  --external fuse-native \
  --define __BOOT_VERSION__="\"$VERSION\"" >/dev/null
chmod +x "$OUTPUT"

printf 'Built %s\n' "$OUTPUT"
