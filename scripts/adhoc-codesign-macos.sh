#!/usr/bin/env bash
#
# Ad-hoc codesign a macOS binary produced by `bun build --compile`.
#
# Bun can embed a truncated LC_CODE_SIGNATURE that the kernel rejects, SIGKILLing
# the binary before it runs. We build with BUN_NO_CODESIGN_MACHO_BINARY=1 (skip
# Bun's own signing) and ad-hoc sign here instead, which produces a valid,
# runnable binary. No-ops on non-macOS so it's safe to call unconditionally.
#
set -euo pipefail

BIN="${1:?usage: adhoc-codesign-macos.sh <binary>}"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

codesign --force --sign - "$BIN"
codesign --verify --strict "$BIN"
