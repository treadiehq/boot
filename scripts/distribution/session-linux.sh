#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="boot-session-filesystem-tests:local"
docker build -t "$IMAGE" - < "$SCRIPT_DIR/session-linux.Dockerfile"
# The Docker VM supplies loop devices and mount support. Only disposable disk
# images inside this container are formatted. The source bind is read-only.
docker run --rm --privileged \
  --mount "type=bind,source=$ROOT,target=/input,readonly" \
  "$IMAGE" bash /input/scripts/distribution/session-linux-inner.sh
