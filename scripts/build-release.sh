#!/usr/bin/env bash
#
# Build standalone boot binaries for supported platforms.
#
# Output: dist/release/boot-<os>-<arch>  (linux/darwin × x64/arm64, plus windows-x64.exe)
# Requires Bun and Node.js. macOS binaries are ad-hoc signed when this runs on macOS.
#
#   bash scripts/build-release.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$ROOT/src/index.ts"
OUT="$ROOT/dist/release"

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to build binaries. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "Node.js is required to read the package version." >&2
  exit 1
}

VERSION="$(node -p "require('$ROOT/package.json').version")"
[ -n "$VERSION" ] || { echo "Could not read the package version." >&2; exit 1; }
echo "Building boot v$VERSION with Bun $(bun --version)"

rm -rf "$OUT"
mkdir -p "$OUT"

# name : bun target
PLATFORMS=(
  "boot-linux-x64:bun-linux-x64"
  "boot-linux-arm64:bun-linux-arm64"
  "boot-darwin-x64:bun-darwin-x64"
  "boot-darwin-arm64:bun-darwin-arm64"
  "boot-windows-x64.exe:bun-windows-x64"
)

for entry in "${PLATFORMS[@]}"; do
  NAME="${entry%%:*}"
  TARGET="${entry##*:}"
  OUTFILE="$OUT/$NAME"

  printf '  %-22s' "$NAME"

  unset BUN_NO_CODESIGN_MACHO_BINARY
  case "$NAME" in
    *darwin*) export BUN_NO_CODESIGN_MACHO_BINARY=1 ;;
  esac

  # Keep the optional fuse-native addon external. Embed the package version because
  # a compiled binary has no package.json beside it.
  bun build "$ENTRY" \
    --compile \
    --target="$TARGET" \
    --outfile="$OUTFILE" \
    --external fuse-native \
    --define __BOOT_VERSION__="\"$VERSION\"" >/dev/null

  case "$NAME" in
    *darwin*)
      if [ "$(uname -s)" = "Darwin" ]; then
        bash "$SCRIPT_DIR/adhoc-codesign-macos.sh" "$OUTFILE"
      fi
      ;;
  esac

  echo "done ($(du -h "$OUTFILE" | cut -f1))"
done

echo
echo "Binaries written to $OUT:"
ls -lh "$OUT"
