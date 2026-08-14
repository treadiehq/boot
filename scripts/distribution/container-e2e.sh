#!/usr/bin/env bash
#
# Runs inside a clean Ubuntu-derived image. The Boot binary is mounted at
# /opt/boot-under-test and all Git remotes are created under the temporary root.
#
set -euo pipefail

BOOT_BIN="${BOOT_BIN:-/opt/boot-under-test}"

die() {
  printf 'Distribution E2E failed: %s\n' "$*" >&2
  exit 1
}

for command_name in git jq sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "$command_name is missing from the test image."
done
[[ -x "$BOOT_BIN" ]] || die "Boot binary is not executable at $BOOT_BIN."

WORK="$(mktemp -d /tmp/boot-distribution-e2e.XXXXXX)"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

export HOME="$WORK/home"
export NO_COLOR=1
export TERM=dumb
export DIST_E2E_TOKEN="boot-distribution-secret-sentinel"
mkdir -p "$HOME"
git config --global user.name "Boot Distribution E2E"
git config --global user.email "distribution-e2e@example.invalid"
git config --global init.defaultBranch main

APP_SOURCE="$WORK/app-source"
APP_REMOTE="$WORK/app.git"
DOCS_SOURCE="$WORK/docs-source"
DOCS_REMOTE="$WORK/docs.git"
MAP_SOURCE="$WORK/map-source"
MAP_REMOTE="$WORK/map.git"
WORKSPACE="$WORK/workspace"
OUTPUT_DIR="$WORK/output"
mkdir -p "$OUTPUT_DIR"

git init -q "$APP_SOURCE"
cat > "$APP_SOURCE/.gitignore" <<'EOF'
.boot-setup-complete
.boot-test-passed
EOF
printf 'distribution fixture\n' > "$APP_SOURCE/payload.txt"
cat > "$APP_SOURCE/test.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(cat payload.txt)" == "distribution fixture" ]]
[[ "$(cat .boot-setup-complete)" == "setup-ok" ]]
printf 'test-ok\n' > .boot-test-passed
EOF
chmod +x "$APP_SOURCE/test.sh"
git -C "$APP_SOURCE" add -A
git -C "$APP_SOURCE" commit -q -m "create application fixture"
git init -q --bare "$APP_REMOTE"
git -C "$APP_SOURCE" remote add origin "$APP_REMOTE"
git -C "$APP_SOURCE" push -q -u origin main
git -C "$APP_REMOTE" symbolic-ref HEAD refs/heads/main

git init -q "$DOCS_SOURCE"
printf 'profile-excluded fixture\n' > "$DOCS_SOURCE/README.txt"
git -C "$DOCS_SOURCE" add -A
git -C "$DOCS_SOURCE" commit -q -m "create excluded fixture"
git init -q --bare "$DOCS_REMOTE"
git -C "$DOCS_SOURCE" remote add origin "$DOCS_REMOTE"
git -C "$DOCS_SOURCE" push -q -u origin main
git -C "$DOCS_REMOTE" symbolic-ref HEAD refs/heads/main

git init -q "$MAP_SOURCE"
cat > "$MAP_SOURCE/boot.yaml" <<EOF
schemaVersion: 1
workspace:
  id: distribution/e2e
  name: Distribution E2E
repositories:
  app:
    url: $APP_REMOTE
    path: services/app
  docs:
    url: $DOCS_REMOTE
    path: docs
commands:
  setup:
    run: >-
      test -f .boot-setup-complete ||
      printf 'setup-ok\n' > .boot-setup-complete
    repository: app
  test:
    run: ./test.sh
    repository: app
env:
  required:
    - name: DIST_E2E_TOKEN
      secret: true
      source: process
profiles:
  local:
    repositories: all
    commands: all
    env: all
    hydrate: manual
  agent:
    repositories:
      - app
    commands:
      - setup
      - test
    env:
      - DIST_E2E_TOKEN
    hydrate: eager
defaults:
  profile: local
EOF
git -C "$MAP_SOURCE" add boot.yaml
git -C "$MAP_SOURCE" commit -q -m "publish distribution workspace"
git init -q --bare "$MAP_REMOTE"
git -C "$MAP_SOURCE" remote add origin "$MAP_REMOTE"
git -C "$MAP_SOURCE" push -q -u origin main
git -C "$MAP_REMOTE" symbolic-ref HEAD refs/heads/main
MAP_COMMIT="$(git -C "$MAP_SOURCE" rev-parse HEAD)"
export MAP_COMMIT

assert_one_json_document() {
  local file="$1"
  local label="$2"
  jq -s -e 'length == 1' "$file" >/dev/null ||
    die "$label stdout was not exactly one JSON document."
}

assert_json() {
  local file="$1"
  local filter="$2"
  local message="$3"
  jq -e "$filter" "$file" >/dev/null || die "$message"
}

FIRST_STDOUT="$OUTPUT_DIR/agent-first.json"
FIRST_STDERR="$OUTPUT_DIR/agent-first.stderr"
SECOND_STDOUT="$OUTPUT_DIR/agent-second.json"
SECOND_STDERR="$OUTPUT_DIR/agent-second.stderr"
INSPECT_STDOUT="$OUTPUT_DIR/inspect.json"
INSPECT_STDERR="$OUTPUT_DIR/inspect.stderr"
VERSION_STDOUT="$OUTPUT_DIR/version.stdout"
VERSION_STDERR="$OUTPUT_DIR/version.stderr"
TEST_STDOUT="$OUTPUT_DIR/test.stdout"
TEST_STDERR="$OUTPUT_DIR/test.stderr"

"$BOOT_BIN" --version >"$VERSION_STDOUT" 2>"$VERSION_STDERR" ||
  die "the standalone binary could not print its version."

"$BOOT_BIN" agent "$MAP_REMOTE" "$WORKSPACE" \
  --profile agent --run-setup --map-commit "$MAP_COMMIT" --ephemeral --json \
  >"$FIRST_STDOUT" 2>"$FIRST_STDERR" ||
  die "the first boot agent run failed."
assert_one_json_document "$FIRST_STDOUT" "first boot agent run"
assert_json "$FIRST_STDOUT" \
  '.schemaVersion == 1
   and .mode == "workspace"
   and .source.state == "linked"
   and .source.commit == env.MAP_COMMIT
   and .source.pinned == true
   and .ephemeral == true
   and .ready == true' \
  "the first boot agent result did not report a ready linked workspace."
assert_json "$FIRST_STDOUT" \
  '.diagnostics.workspace.profile == "agent"
   and (.diagnostics.repositories | length) == 1
   and .diagnostics.repositories[0].id == "app"
   and .diagnostics.repositories[0].state == "hydrated"
   and .diagnostics.repositories[0].action == "none"' \
  "the agent profile did not hydrate exactly the selected app repository."
assert_json "$FIRST_STDOUT" \
  'any(.applied[]; .kind == "repository" and .name == "app")
   and any(.applied[]; .kind == "command" and .name == "setup")
   and (.failures | length) == 0' \
  "the first boot agent run did not clone app and run setup cleanly."

MARKER="$WORKSPACE/services/app/.boot-setup-complete"
[[ -f "$MARKER" ]] || die "the declared setup command did not create its marker."
[[ "$(cat "$MARKER")" == "setup-ok" ]] || die "the setup marker had unexpected content."
[[ ! -e "$WORKSPACE/docs" ]] || die "the agent profile materialized the excluded docs repository."
MARKER_CHECKSUM="$(sha256sum "$MARKER" | awk '{print $1}')"

"$BOOT_BIN" agent "$MAP_REMOTE" "$WORKSPACE" \
  --profile agent --run-setup --map-commit "$MAP_COMMIT" --ephemeral --json \
  >"$SECOND_STDOUT" 2>"$SECOND_STDERR" ||
  die "the second boot agent run failed."
assert_one_json_document "$SECOND_STDOUT" "second boot agent run"
assert_json "$SECOND_STDOUT" \
  '.source.state == "updated"
   and .source.commit == env.MAP_COMMIT
   and .source.pinned == true
   and .ephemeral == true
   and .ready == true
   and (.failures | length) == 0' \
  "the repeated boot agent run did not remain ready."
assert_json "$SECOND_STDOUT" \
  '([.applied[] | select(.kind == "repository")] | length) == 0
   and ([.applied[] | select(.kind == "command" and .name == "setup")] | length) == 1' \
  "the repeated boot agent run was not repository-idempotent."
[[ "$(sha256sum "$MARKER" | awk '{print $1}')" == "$MARKER_CHECKSUM" ]] ||
  die "the idempotent setup command changed its marker."
[[ "$(wc -l < "$MARKER" | tr -d ' ')" == "1" ]] ||
  die "the repeated setup command duplicated marker content."
[[ ! -e "$HOME/.boot/machine.json" ]] ||
  die "ephemeral bootstrap wrote a machine identity."
[[ ! -d "$WORKSPACE/.boot/map/machines" ]] ||
  die "ephemeral bootstrap wrote machine state into the map."
[[ "$(git -C "$MAP_REMOTE" rev-parse HEAD)" == "$MAP_COMMIT" ]] ||
  die "ephemeral bootstrap changed the remote map commit."

"$BOOT_BIN" inspect "$WORKSPACE" --json >"$INSPECT_STDOUT" 2>"$INSPECT_STDERR" ||
  die "boot inspect --json failed."
assert_one_json_document "$INSPECT_STDOUT" "boot inspect"
assert_json "$INSPECT_STDOUT" \
  '.schemaVersion == 1
   and .workspace.id == "distribution/e2e"
   and .workspace.profile == "agent"
   and .workspace.ready == true
   and (.repositories | length) == 1
   and .repositories[0].id == "app"
   and .repositories[0].state == "hydrated"
   and .commands.test.run == "./test.sh"
   and (.blockers | length) == 0' \
  "boot inspect did not preserve the ready agent-profile scope and test command."

TEST_COMMAND="$(jq -r '.commands.test.run' "$INSPECT_STDOUT")"
(cd "$WORKSPACE/services/app" && bash -c "$TEST_COMMAND") >"$TEST_STDOUT" 2>"$TEST_STDERR" ||
  die "the test command declared by the workspace failed."
[[ -f "$WORKSPACE/services/app/.boot-test-passed" ]] ||
  die "the declared test command did not create its pass marker."

for output in \
  "$VERSION_STDOUT" "$VERSION_STDERR" \
  "$FIRST_STDOUT" "$FIRST_STDERR" \
  "$SECOND_STDOUT" "$SECOND_STDERR" \
  "$INSPECT_STDOUT" "$INSPECT_STDERR" \
  "$TEST_STDOUT" "$TEST_STDERR"; do
  if LC_ALL=C grep -q $'\033' "$output"; then
    die "ANSI escape bytes leaked into $(basename "$output")."
  fi
  if grep -qF "$DIST_E2E_TOKEN" "$output"; then
    die "the secret sentinel leaked into $(basename "$output")."
  fi
done

printf 'Distribution E2E passed: standalone binary, profile scope, setup/test, JSON, and idempotency\n'
