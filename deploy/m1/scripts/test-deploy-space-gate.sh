#!/usr/bin/env bash
# Isolated command shims exercise deploy.sh without a Docker daemon or deployment host.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
test_dir="$(mktemp -d "${PWD}/.deploy-space-test.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/deploy/m1/scripts" "$test_dir/bin" "$test_dir/docker-root" "$test_dir/state"
cp "$script_dir/deploy.sh" "$script_dir/lib.sh" "$test_dir/deploy/m1/scripts/"
printf 'BB_PROFILE=prod\nBB_HTTP_PORT=18090\n' > "$test_dir/deploy/m1/.env"
printf 'old-release\n' > "$test_dir/state/current"
printf 'old-release\n' > "$test_dir/state/previous"
cat > "$test_dir/deploy/m1/scripts/backup.sh" <<'SH'
#!/usr/bin/env bash
echo "backup image=$BB_IMAGE_TAG source=$BB_BACKUP_SOURCE_TAG" >> "$TEST_CALLS"
SH
cat > "$test_dir/deploy/m1/scripts/smoke.sh" <<'SH'
#!/usr/bin/env bash
echo smoke >> "$TEST_CALLS"
SH
chmod +x "$test_dir/deploy/m1/scripts/backup.sh" "$test_dir/deploy/m1/scripts/smoke.sh"
cat > "$test_dir/bin/git" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *' rev-parse --show-toplevel '*) printf '%s\n' "$TEST_ROOT" ;;
  *' rev-parse --verify '*) printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
  *' archive '*) echo archive >> "$TEST_CALLS" ;;
  *) exit 1 ;;
esac
SH
cat > "$test_dir/bin/tar" <<'SH'
#!/usr/bin/env bash
echo tar >> "$TEST_CALLS"
SH
cat > "$test_dir/bin/docker" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *' context inspect '*) printf 'unix:///var/run/docker.sock\n' ;;
  *' info --format '*)
    [ "$TEST_ROOT_MODE" = valid ] || exit 1
    printf '%s\n' "$TEST_ROOT/docker-root"
    ;;
  *' image inspect '*)
    if [ "$TEST_IMAGES" = all ]; then exit 0; fi
    if [ "$TEST_IMAGES" = partial ] && [[ "$*" = *'bondbuddy-m1-api:'* ]]; then exit 0; fi
    if [[ "$TEST_IMAGES" = vanish-* ]]; then
      count="$(cat "$TEST_INSPECT_COUNT")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$TEST_INSPECT_COUNT"
      if [ "$TEST_IMAGES" = vanish-api ] && [ "$count" -eq 5 ]; then exit 1; fi
      if [ "$TEST_IMAGES" = vanish-egress ] && [ "$count" -eq 8 ]; then exit 1; fi
      exit 0
    fi
    exit 1
    ;;
  *' image ls '*)
    printf '%s\n' "$*" >> "$TEST_CALLS"
    printf 'bondbuddy-m1-api:aaaaaaaaaaaa\n'
    ;;
  *' compose '*' ps --status running --services '*)
    printf '%s\n' "$*" >> "$TEST_CALLS"
    printf 'postgres\n'
    ;;
  *' compose '*|*' build '*|*' image rm '*)
    printf '%s\n' "$*" >> "$TEST_CALLS"
    ;;
  *) exit 1 ;;
esac
SH
cat > "$test_dir/bin/df" <<'SH'
#!/usr/bin/env bash
echo df >> "$TEST_CALLS"
[ "$TEST_DF_MODE" = valid ] || exit 1
[[ "$*" = *"$TEST_ROOT/docker-root"* ]] || exit 1
printf ' Avail\n%s\n' "$TEST_FREE_BYTES"
SH
chmod +x "$test_dir/bin/"*
export TEST_ROOT="$test_dir" TEST_CALLS="$test_dir/calls" TEST_INSPECT_COUNT="$test_dir/inspect-count"
export BB_ENV_FILE="$test_dir/deploy/m1/.env" BB_STATE_DIR="$test_dir/state"
export PATH="$test_dir/bin:$PATH" TEST_ROOT_MODE=valid TEST_DF_MODE=valid
unset DOCKER_HOST DOCKER_CONTEXT

run_case() {
  local label="$1" expected="$2" result=0
  : > "$TEST_CALLS"
  printf '0\n' > "$TEST_INSPECT_COUNT"
  printf 'old-release\n' > "$test_dir/state/current"
  "$test_dir/deploy/m1/scripts/deploy.sh" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    > "$test_dir/output" 2> "$test_dir/error" || result=$?
  if [[ "$expected" = reject* ]]; then
    [ "$result" -ne 0 ] || { echo "$label: expected rejection" >&2; exit 1; }
    [ "$(cat "$test_dir/state/current")" = old-release ] || exit 1
    [ "$(cat "$test_dir/state/previous")" = old-release ] || exit 1
    if [ "$expected" = reject_after_archive ]; then
      rg -q '^archive$' "$TEST_CALLS"
      forbidden='build|compose|backup|image rm|smoke'
    else
      forbidden='archive|tar|build|compose|backup|image rm|smoke'
    fi
    if rg -q "$forbidden" "$TEST_CALLS"; then
      echo "$label: side effect before rejection" >&2; exit 1
    fi
  else
    [ "$result" -eq 0 ] || { echo "$label: unexpected rejection ($result)" >&2; cat "$test_dir/error" "$test_dir/output" "$TEST_CALLS" >&2; exit 1; }
    rg -q '^archive$' "$TEST_CALLS"
    rg -q 'compose' "$TEST_CALLS"
  fi
  echo "PASS $label"
}

export TEST_IMAGES=partial TEST_FREE_BYTES=2684354560
printf 'BB_PROFILE=prod\nBB_HTTP_PORT=18090\nBB_DEPLOYMENT_TIER=production\nBB_NON_PRODUCTION_TEST_CHANNEL=enabled\n' > "$test_dir/deploy/m1/.env"
run_case 'production rejects enabled test channel before archive' reject
rg -q 'requires BB_DEPLOYMENT_TIER=preprod' "$test_dir/error"
printf 'BB_PROFILE=prod\nBB_HTTP_PORT=18090\nBB_DEPLOYMENT_TIER=production\nBB_NON_PRODUCTION_TEST_CHANNEL=disabled\n' > "$test_dir/deploy/m1/.env"
run_case 'local build rejects at 2.5 GiB' reject
rg -q '2684354560 bytes available; requires 4294967296 bytes.*local Docker build' "$test_dir/error"
export TEST_FREE_BYTES=4294967296
run_case 'local build passes at 4 GiB' pass
rg -q 'build' "$TEST_CALLS"
export TEST_IMAGES=all TEST_FREE_BYTES=2684354560
run_case 'four preloaded images pass at 2.5 GiB' pass
rg -q '^backup image=aaaaaaaaaaaa source=old-release$' "$TEST_CALLS"
if rg -q 'build' "$TEST_CALLS"; then echo 'unexpected build with preloaded images' >&2; exit 1; fi
export TEST_FREE_BYTES=2684354559
run_case 'preloaded deploy rejects below 2.5 GiB' reject
rg -q '2684354559 bytes available; requires 2684354560 bytes.*preloaded' "$test_dir/error"
export TEST_DF_MODE=fail
run_case 'df failure rejects' reject
rg -q 'df failed.*2684354560 bytes.*preloaded' "$test_dir/error"
export TEST_DF_MODE=valid TEST_FREE_BYTES=unknown
run_case 'malformed df output rejects' reject
rg -q 'cannot read free bytes' "$test_dir/error"
export TEST_FREE_BYTES=18446744073709551616
run_case 'out-of-range df output rejects' reject
rg -q '18446744073709551616 bytes outside shell integer range; required 2684354560 bytes' "$test_dir/error"
export TEST_DF_MODE=valid TEST_ROOT_MODE=fail
run_case 'unknown Docker data-root rejects' reject
rg -q 'cannot determine Docker data-root' "$test_dir/error"
export TEST_ROOT_MODE=valid DOCKER_HOST=tcp://remote:2375
run_case 'remote Docker endpoint rejects' reject
rg -q 'not a local Unix socket' "$test_dir/error"
unset DOCKER_HOST
export TEST_IMAGES=vanish-api TEST_FREE_BYTES=2684354560
run_case 'preloaded api disappears before build' reject_after_archive
rg -q 'requires 4294967296 bytes.*api image missing' "$test_dir/error"
export TEST_IMAGES=vanish-egress
run_case 'preloaded egress disappears before build' reject_after_archive
rg -q 'requires 4294967296 bytes.*egress image missing' "$test_dir/error"
