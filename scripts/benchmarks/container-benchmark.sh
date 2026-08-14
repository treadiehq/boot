#!/usr/bin/env bash
#
# Emit JSONL benchmark samples to stdout. Fixture construction, image startup,
# and warmups are excluded from recorded durations. Each recorded trial starts
# with a fresh workspace and uses local bare Git remotes.
#
set -euo pipefail

BOOT_BIN="${BOOT_BIN:-/opt/boot-under-test}"
ITERATIONS="${ITERATIONS:-10}"
WARMUPS="${WARMUPS:-1}"

die() {
  printf 'Benchmark failed: %s\n' "$*" >&2
  exit 1
}

[[ -x "$BOOT_BIN" ]] || die "Boot binary is not executable at $BOOT_BIN."
[[ "$ITERATIONS" =~ ^[1-9][0-9]*$ ]] || die "ITERATIONS must be a positive integer."
[[ "$WARMUPS" =~ ^[0-9]+$ ]] || die "WARMUPS must be a non-negative integer."
for command_name in date git jq; do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "$command_name is missing from the benchmark image."
done

WORK="$(mktemp -d /tmp/boot-benchmark.XXXXXX)"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

export HOME="$WORK/home"
export NO_COLOR=1
export TERM=dumb
mkdir -p "$HOME"
git config --global user.name "Boot Benchmark"
git config --global user.email "benchmark@example.invalid"
git config --global init.defaultBranch main

APP_SOURCE="$WORK/app-source"
APP_REMOTE="$WORK/app.git"
MAP_SOURCE="$WORK/map-source"
MAP_REMOTE="$WORK/map.git"
mkdir -p "$WORK/trials"

git init -q "$APP_SOURCE"
cat > "$APP_SOURCE/.gitignore" <<'EOF'
.setup-complete
EOF
printf 'benchmark fixture\n' > "$APP_SOURCE/payload.txt"
cat > "$APP_SOURCE/setup.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${BENCH_INJECT_SETUP_FAILURE:-0}" == "1" ]]; then
  printf 'injected setup failure\n' >&2
  exit 42
fi
test -f .setup-complete || printf 'setup-ok\n' > .setup-complete
EOF
cat > "$APP_SOURCE/test.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(cat payload.txt)" == "benchmark fixture" ]]
[[ "$(cat .setup-complete)" == "setup-ok" ]]
EOF
chmod +x "$APP_SOURCE/setup.sh" "$APP_SOURCE/test.sh"
git -C "$APP_SOURCE" add -A
git -C "$APP_SOURCE" commit -q -m "create benchmark fixture"
git init -q --bare "$APP_REMOTE"
git -C "$APP_SOURCE" remote add origin "$APP_REMOTE"
git -C "$APP_SOURCE" push -q -u origin main
git -C "$APP_REMOTE" symbolic-ref HEAD refs/heads/main

git init -q "$MAP_SOURCE"
cat > "$MAP_SOURCE/boot.yaml" <<EOF
schemaVersion: 1
workspace:
  id: benchmark/local
  name: Local Benchmark
repositories:
  app:
    url: $APP_REMOTE
    path: app
commands:
  setup:
    run: ./setup.sh
    repository: app
  test:
    run: ./test.sh
    repository: app
profiles:
  agent:
    repositories:
      - app
    commands:
      - setup
      - test
    hydrate: eager
defaults:
  profile: agent
EOF
git -C "$MAP_SOURCE" add boot.yaml
git -C "$MAP_SOURCE" commit -q -m "publish benchmark workspace"
git init -q --bare "$MAP_REMOTE"
git -C "$MAP_SOURCE" remote add origin "$MAP_REMOTE"
git -C "$MAP_SOURCE" push -q -u origin main
git -C "$MAP_REMOTE" symbolic-ref HEAD refs/heads/main

TRIAL_SEQUENCE=0

run_trial() {
  local mode="$1"
  local scenario="$2"
  local iteration="$3"
  local workspace="$WORK/trials/${TRIAL_SEQUENCE}-${mode}-${scenario}"
  local stdout_file="$WORK/trials/${TRIAL_SEQUENCE}.stdout"
  local stderr_file="$WORK/trials/${TRIAL_SEQUENCE}.stderr"
  local inspect_file="$WORK/trials/${TRIAL_SEQUENCE}.inspect.json"
  local inject_failure=0
  local setup_exit=0
  local test_exit=-1
  local setup_failed=false
  local test_passed=false
  local error_detected_json=null
  local diagnostic_complete_json=null
  local time_to_first_test_json=null
  local test_directory test_command
  local start_ns end_ns elapsed_ms

  TRIAL_SEQUENCE=$((TRIAL_SEQUENCE + 1))
  [[ "$scenario" == "setup_failure" ]] && inject_failure=1

  start_ns="$(date +%s%N)"
  if [[ "$mode" == "boot" ]]; then
    set +e
    BENCH_INJECT_SETUP_FAILURE="$inject_failure" \
      "$BOOT_BIN" agent "$MAP_REMOTE" "$workspace" \
        --profile agent --run-setup --ephemeral --json \
        >"$stdout_file" 2>"$stderr_file"
    setup_exit=$?
    set -e

    if ! jq -s -e 'length == 1' "$stdout_file" >/dev/null 2>&1; then
      setup_exit=97
    fi
    if [[ "$scenario" == "setup_failure" ]]; then
      if jq -e \
        '.ready == false
         and any(.failures[];
           .kind == "command"
           and .name == "setup"
           and (.message | contains("status 42")))' \
        "$stdout_file" >/dev/null 2>&1; then
        diagnostic_complete_json=true
      else
        diagnostic_complete_json=false
      fi
    fi
  else
    set +e
    mkdir -p "$workspace"
    git clone -q "$APP_REMOTE" "$workspace/app" >"$stdout_file" 2>"$stderr_file"
    setup_exit=$?
    if (( setup_exit == 0 )); then
      (
        cd "$workspace/app"
        BENCH_INJECT_SETUP_FAILURE="$inject_failure" ./setup.sh
      ) >>"$stdout_file" 2>>"$stderr_file"
      setup_exit=$?
    fi
    set -e
  fi

  if (( setup_exit == 0 )); then
    if [[ "$mode" == "boot" ]]; then
      set +e
      "$BOOT_BIN" inspect "$workspace" --json \
        >"$inspect_file" 2>>"$stderr_file"
      inspect_exit=$?
      set -e
      if (( inspect_exit != 0 )) ||
        ! jq -s -e 'length == 1' "$inspect_file" >/dev/null 2>&1; then
        setup_exit=98
        setup_failed=true
      else
        test_directory="$(jq -er '.repositories[] | select(.id == "app").path' "$inspect_file")"
        test_command="$(jq -er '.commands.test.run' "$inspect_file")"
      fi
    else
      test_directory="$workspace/app"
      test_command="./test.sh"
    fi
  fi

  if (( setup_exit == 0 )); then
    set +e
    (cd "$test_directory" && bash -c "$test_command") \
      >>"$stdout_file" 2>>"$stderr_file"
    test_exit=$?
    set -e
    if (( test_exit == 0 )); then
      test_passed=true
    fi
  else
    setup_failed=true
  fi

  end_ns="$(date +%s%N)"
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  if [[ "$test_passed" == true ]]; then
    time_to_first_test_json="$elapsed_ms"
  fi
  if [[ "$scenario" == "setup_failure" ]]; then
    if [[ "$mode" == "boot" && "$diagnostic_complete_json" == true ]]; then
      error_detected_json=true
    elif [[ "$mode" == "manual-informed" && "$setup_exit" == 42 ]]; then
      error_detected_json=true
    else
      error_detected_json=false
    fi
  fi

  jq -cn \
    --arg mode "$mode" \
    --arg scenario "$scenario" \
    --argjson iteration "$iteration" \
    --argjson elapsed_ms "$elapsed_ms" \
    --argjson time_to_first_test_ms "$time_to_first_test_json" \
    --argjson setup_failed "$setup_failed" \
    --argjson test_passed "$test_passed" \
    --argjson error_detected "$error_detected_json" \
    --argjson diagnostic_complete "$diagnostic_complete_json" \
    --argjson exit_code "$setup_exit" \
    '{
      schema_version: 1,
      benchmark: "time-to-first-test",
      mode: $mode,
      baseline: (if $mode == "manual-informed" then "manual steps informed by boot.yaml" else null end),
      scenario: $scenario,
      iteration: $iteration,
      elapsed_ms: $elapsed_ms,
      time_to_first_test_ms: $time_to_first_test_ms,
      setup_failed: $setup_failed,
      test_passed: $test_passed,
      error_detected: $error_detected,
      diagnostic_complete: $diagnostic_complete,
      exit_code: $exit_code,
      fixture: {
        git_remotes: "local-bare",
        workspace: "fresh-per-trial",
        network_in_timed_region: false
      },
      scope: "deterministic setup mechanics only; no LLM reasoning"
    }'

  rm -rf "$workspace" "$stdout_file" "$stderr_file" "$inspect_file"
}

if (( WARMUPS > 0 )); then
  printf 'Running %s unrecorded warmup(s) per mode\n' "$WARMUPS" >&2
  for (( warmup = 1; warmup <= WARMUPS; warmup += 1 )); do
    run_trial boot success 0 >/dev/null
    run_trial manual-informed success 0 >/dev/null
  done
fi

printf 'Recording %s iteration(s) per mode and scenario\n' "$ITERATIONS" >&2
for (( iteration = 1; iteration <= ITERATIONS; iteration += 1 )); do
  if (( iteration % 2 == 1 )); then
    methods=(boot manual-informed)
    scenarios=(success setup_failure)
  else
    methods=(manual-informed boot)
    scenarios=(setup_failure success)
  fi

  for scenario in "${scenarios[@]}"; do
    for mode in "${methods[@]}"; do
      run_trial "$mode" "$scenario" "$iteration"
    done
  done
done
