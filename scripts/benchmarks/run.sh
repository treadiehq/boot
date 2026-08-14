#!/usr/bin/env bash
#
# Compare Boot with a manual-informed setup using deterministic local fixtures.
# This measures setup mechanics through the first test, not LLM reasoning.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BINARY=""
BASE_IMAGE="ubuntu:24.04"
ITERATIONS=10
WARMUPS=1
SMOKE=false
OUTPUT="$ROOT/dist/benchmarks/results.jsonl"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: run.sh [options]

Compare Boot with a manual-informed setup against local bare Git remotes.
Each trial uses a fresh workspace. Recorded time starts immediately before
workspace setup and ends after the first test passes; fixture/image creation,
network access, and warmups are excluded. This benchmark does not measure or
claim anything about LLM reasoning speed.

Options:
  --binary <path>       Standalone Linux binary to test
  --smoke               Fast correctness run: 1 iteration, no warmups
  --iterations <count>  Recorded iterations per mode/scenario (default: 10)
  --warmups <count>     Unrecorded successful warmups per mode (default: 1)
  --output <path>       JSONL output (default: dist/benchmarks/results.jsonl)
  --image <image>       Ubuntu base image (default: ubuntu:24.04)
  -h, --help            Show this help

Examples:
  bash scripts/benchmarks/run.sh --smoke \
    --binary dist/release/boot-linux-x64
  bash scripts/benchmarks/run.sh --iterations 30 --warmups 2 \
    --output dist/benchmarks/full.jsonl
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --binary)
      (( $# >= 2 )) || die "--binary requires a path."
      BINARY="$2"
      shift 2
      ;;
    --smoke)
      SMOKE=true
      shift
      ;;
    --iterations)
      (( $# >= 2 )) || die "--iterations requires a count."
      ITERATIONS="$2"
      shift 2
      ;;
    --warmups)
      (( $# >= 2 )) || die "--warmups requires a count."
      WARMUPS="$2"
      shift 2
      ;;
    --output)
      (( $# >= 2 )) || die "--output requires a path."
      OUTPUT="$2"
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

if [[ "$SMOKE" == true ]]; then
  ITERATIONS=1
  WARMUPS=0
fi
[[ "$ITERATIONS" =~ ^[1-9][0-9]*$ ]] ||
  die "--iterations must be a positive integer."
[[ "$WARMUPS" =~ ^[0-9]+$ ]] ||
  die "--warmups must be a non-negative integer."

command -v docker >/dev/null 2>&1 ||
  die "Docker is required. Install Docker Desktop or Docker Engine, then retry."
docker info >/dev/null 2>&1 ||
  die "the Docker daemon is unavailable. Start Docker and verify 'docker info' succeeds."
command -v python3 >/dev/null 2>&1 ||
  die "Python 3 is required to summarize benchmark results."

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

if [[ -z "$BINARY" ]]; then
  BINARY="$ROOT/dist/release/boot-linux-$ARCH"
elif [[ "$BINARY" != /* ]]; then
  BINARY="$(cd "$(dirname "$BINARY")" 2>/dev/null && pwd -P)/$(basename "$BINARY")" ||
    die "binary path does not exist: $BINARY"
fi
[[ -f "$BINARY" ]] || die "binary not found: $BINARY"
[[ -x "$BINARY" ]] ||
  die "binary is not executable: $BINARY. Run: chmod +x '$BINARY'"

if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$PWD/$OUTPUT"
fi
mkdir -p "$(dirname "$OUTPUT")"
TEMP_OUTPUT="$OUTPUT.tmp.$$"
SUMMARY_OUTPUT="$OUTPUT.summary.json"
cleanup() {
  rm -f "$TEMP_OUTPUT"
}
trap cleanup EXIT

printf 'Building reproducible benchmark image from %s\n' "$BASE_IMAGE"
IMAGE_ID="$(
  docker build \
    --quiet \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --file "$SCRIPT_DIR/Dockerfile" \
    "$SCRIPT_DIR"
)" || die "failed to build the Ubuntu benchmark image."
[[ -n "$IMAGE_ID" ]] || die "Docker did not return a benchmark image identifier."

printf 'Running benchmark: %s iteration(s), %s warmup(s)\n' "$ITERATIONS" "$WARMUPS"
if ! docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=1g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env "ITERATIONS=$ITERATIONS" \
  --env "WARMUPS=$WARMUPS" \
  --mount "type=bind,source=$BINARY,target=/opt/boot-under-test,readonly" \
  --mount "type=bind,source=$SCRIPT_DIR/container-benchmark.sh,target=/opt/container-benchmark.sh,readonly" \
  "$IMAGE_ID" \
  bash /opt/container-benchmark.sh >"$TEMP_OUTPUT"; then
  PARTIAL_OUTPUT="$OUTPUT.partial"
  mv "$TEMP_OUTPUT" "$PARTIAL_OUTPUT"
  die "the benchmark container failed; partial JSONL is at $PARTIAL_OUTPUT."
fi
mv "$TEMP_OUTPUT" "$OUTPUT"

python3 "$SCRIPT_DIR/summarize.py" "$OUTPUT" --json >"$SUMMARY_OUTPUT"
python3 "$SCRIPT_DIR/summarize.py" "$OUTPUT" --check
printf 'JSONL: %s\n' "$OUTPUT"
printf 'Summary JSON: %s\n' "$SUMMARY_OUTPUT"
