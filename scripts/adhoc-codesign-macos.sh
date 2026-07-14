#!/usr/bin/env bash
#
# Ad-hoc sign a macOS binary produced by `bun build --compile`.
#
# The release build disables Bun's signing and signs the result here instead.
# This script does nothing on non-macOS hosts.
#
set -euo pipefail

BIN="${1:?usage: adhoc-codesign-macos.sh <binary>}"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

codesign --force --sign - "$BIN"
codesign --verify --strict "$BIN"
