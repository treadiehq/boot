#!/usr/bin/env bash
#
# Exercise a standalone Linux release binary in a clean Ubuntu container.
#
# Examples:
#   bash scripts/distribution/e2e.sh \
#     --binary dist/release/boot-linux-x64
#
#   bash scripts/distribution/e2e.sh --release v0.3.6
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BINARY=""
RELEASE_TAG=""
RELEASE_URL=""
CHECKSUMS_URL=""
ASSET_NAME=""
REPOSITORY="treadiehq/boot"
BASE_IMAGE="ubuntu:24.04"
TEMP_DIR=""

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: e2e.sh [options]

Run the standalone Linux distribution E2E in a fresh Ubuntu container.
All workspace and repository Git remotes used by the test are local, and the
test container has networking disabled after its image dependencies are built.

Binary selection (choose at most one):
  --binary <path>          Test an existing Linux binary
  --release <tag>          Download a GitHub release asset and SHA256SUMS
  --release-url <url>      Download an asset from an explicit URL

Release download options:
  --checksums-url <url>    SHA256SUMS URL (required with --release-url)
  --asset-name <name>      Asset name in SHA256SUMS (architecture-derived by default)
  --repository <owner/repo>
                           GitHub repository for --release (default: treadiehq/boot)

Container options:
  --image <image>          Ubuntu base image (default: ubuntu:24.04)
  -h, --help               Show this help

With no binary option, the default is dist/release/boot-linux-<docker-arch>.
Docker must be installed and its daemon must be running.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --binary)
      (( $# >= 2 )) || die "--binary requires a path."
      BINARY="$2"
      shift 2
      ;;
    --release)
      (( $# >= 2 )) || die "--release requires a tag such as v0.3.6."
      RELEASE_TAG="$2"
      shift 2
      ;;
    --release-url)
      (( $# >= 2 )) || die "--release-url requires a URL."
      RELEASE_URL="$2"
      shift 2
      ;;
    --checksums-url)
      (( $# >= 2 )) || die "--checksums-url requires a URL."
      CHECKSUMS_URL="$2"
      shift 2
      ;;
    --asset-name)
      (( $# >= 2 )) || die "--asset-name requires a file name."
      ASSET_NAME="$2"
      shift 2
      ;;
    --repository)
      (( $# >= 2 )) || die "--repository requires owner/repo."
      REPOSITORY="$2"
      shift 2
      ;;
    --image)
      (( $# >= 2 )) || die "--image requires an image reference."
      BASE_IMAGE="$2"
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

selection_count=0
[[ -n "$BINARY" ]] && selection_count=$((selection_count + 1))
[[ -n "$RELEASE_TAG" ]] && selection_count=$((selection_count + 1))
[[ -n "$RELEASE_URL" ]] && selection_count=$((selection_count + 1))
(( selection_count <= 1 )) ||
  die "choose only one of --binary, --release, or --release-url."

command -v docker >/dev/null 2>&1 ||
  die "Docker is required. Install Docker Desktop or Docker Engine, then retry."
docker info >/dev/null 2>&1 ||
  die "the Docker daemon is unavailable. Start Docker and verify 'docker info' succeeds."

DOCKER_ARCH="$(docker info --format '{{.Architecture}}')"
case "$DOCKER_ARCH" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    die "unsupported Docker architecture: $DOCKER_ARCH. Expected x86_64 or aarch64."
    ;;
esac
[[ -n "$ASSET_NAME" ]] || ASSET_NAME="boot-linux-$ARCH"

cleanup() {
  [[ -z "$TEMP_DIR" ]] || rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify a downloaded release."
  fi
}

if [[ -n "$RELEASE_TAG" || -n "$RELEASE_URL" ]]; then
  command -v curl >/dev/null 2>&1 ||
    die "curl is required to download a release binary."
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boot-release-e2e.XXXXXX")"

  if [[ -n "$RELEASE_TAG" ]]; then
    RELEASE_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG/$ASSET_NAME"
    CHECKSUMS_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG/SHA256SUMS"
  else
    [[ -n "$CHECKSUMS_URL" ]] ||
      die "--checksums-url is required with --release-url."
  fi

  BINARY="$TEMP_DIR/$ASSET_NAME"
  CHECKSUM_FILE="$TEMP_DIR/SHA256SUMS"
  printf 'Downloading release asset and checksum manifest\n'
  curl -fsSL --retry 3 "$RELEASE_URL" -o "$BINARY" ||
    die "release asset download failed."
  curl -fsSL --retry 3 "$CHECKSUMS_URL" -o "$CHECKSUM_FILE" ||
    die "release checksum manifest download failed."

  EXPECTED="$(
    awk -v asset="$ASSET_NAME" \
      '$2 == asset || $2 == "*" asset || $2 == "./" asset { print $1; exit }' \
      "$CHECKSUM_FILE"
  )"
  [[ "$EXPECTED" =~ ^[0-9A-Fa-f]{64}$ ]] ||
    die "SHA256SUMS did not contain a valid checksum for $ASSET_NAME."
  ACTUAL="$(sha256_file "$BINARY")"
  ACTUAL_NORMALIZED="$(printf '%s' "$ACTUAL" | tr 'A-F' 'a-f')"
  EXPECTED_NORMALIZED="$(printf '%s' "$EXPECTED" | tr 'A-F' 'a-f')"
  [[ "$ACTUAL_NORMALIZED" == "$EXPECTED_NORMALIZED" ]] ||
    die "release checksum mismatch for $ASSET_NAME."
  printf 'Verified SHA-256 for %s\n' "$ASSET_NAME"
elif [[ -z "$BINARY" ]]; then
  BINARY="$ROOT/dist/release/$ASSET_NAME"
fi

if [[ "$BINARY" != /* ]]; then
  BINARY="$(cd "$(dirname "$BINARY")" 2>/dev/null && pwd -P)/$(basename "$BINARY")" ||
    die "binary path does not exist: $BINARY"
fi
[[ -f "$BINARY" ]] || die "binary not found: $BINARY"
if [[ ! -x "$BINARY" ]]; then
  if [[ -n "$TEMP_DIR" ]]; then
    chmod +x "$BINARY"
  else
    die "binary is not executable: $BINARY. Run: chmod +x '$BINARY'"
  fi
fi

printf 'Building clean test image from %s\n' "$BASE_IMAGE"
IMAGE_ID="$(
  docker build \
    --quiet \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --file "$SCRIPT_DIR/Dockerfile" \
    "$SCRIPT_DIR"
)" || die "failed to build the Ubuntu distribution test image."
[[ -n "$IMAGE_ID" ]] || die "Docker did not return a test image identifier."

printf 'Running standalone distribution E2E with network disabled\n'
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,source=$BINARY,target=/opt/boot-under-test,readonly" \
  --mount "type=bind,source=$SCRIPT_DIR/container-e2e.sh,target=/opt/container-e2e.sh,readonly" \
  "$IMAGE_ID" \
  bash /opt/container-e2e.sh
