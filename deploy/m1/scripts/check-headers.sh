#!/usr/bin/env bash
# Usage: check-headers.sh <base-url>
# Asserts that every M1 route class (SPA, assets, API, SSE, /healthz, error pages) returns the full
# security header set exactly once, no server version, and a single Cache-Control header.
set -euo pipefail
base="${1:?usage: check-headers.sh <base-url>}"; base="${base%/}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
failures=0
fail() { echo "FAIL $1: $2" >&2; failures=$((failures+1)); }
once() { # <label> <headers-file> <header-name> [value-regex]
  local n; n="$(grep -ci "^$3:" "$2" || true)"
  [ "$n" = 1 ] || { fail "$1" "$3 appears $n times"; return; }
  [ -z "${4:-}" ] || grep -qiE "^$3: $4" "$2" || fail "$1" "$3 value: $(grep -i "^$3:" "$2" | tr -d '\r')"
}
check() { # <label> <expected-status> <path> [curl args...]
  local label="$1" want="$2" path="$3"; shift 3
  local h="$tmp/h" status
  status="$(curl -sS -o /dev/null -D "$h" -w '%{http_code}' "$@" "$base$path")"
  [ "$status" = "$want" ] || fail "$label" "status $status, want $want"
  once "$label" "$h" strict-transport-security 'max-age=(1555[2-9][0-9]{3}|15[6-9][0-9]{5}|1[6-9][0-9]{6}|[2-9][0-9]{7}|[0-9]{9,})'
  grep -qi '^strict-transport-security:.*preload' "$h" && fail "$label" "HSTS has preload"
  once "$label" "$h" x-content-type-options nosniff
  once "$label" "$h" x-frame-options DENY
  once "$label" "$h" referrer-policy
  once "$label" "$h" content-security-policy ".*frame-ancestors 'none'"
  [ "$(grep -ci '^cache-control:' "$h" || true)" -le 1 ] || fail "$label" "Cache-Control repeated"
  grep -qiE '^cache-control:.*(no-store.*no-store|no-cache.*no-cache)' "$h" && fail "$label" "Cache-Control value repeated"
  grep -qiE '^server: .*[0-9]' "$h" && fail "$label" "server version exposed"
  grep -qi '^x-powered-by:' "$h" && fail "$label" "x-powered-by exposed"
  cp "$h" "$tmp/last"
  echo "ok $label ($status)"
}
check spa 200 /
check spa-deep-link 200 /projects/does-not-exist
asset="$(curl -sS "$base/" | grep -o '/assets/[^"]*\.js' | head -1)"
[ -n "$asset" ] || fail assets "no asset referenced by /"
check asset 200 "$asset"
grep -qi '^cache-control: public, max-age=31536000, immutable' "$tmp/last" || fail asset "immutable Cache-Control"
check asset-404 404 /assets/missing.js
check healthz 200 /healthz
check api-401 401 /api/v1/me
grep -qi '^cache-control: no-store' "$tmp/last" || fail api-401 "no-store Cache-Control"
check api-404 404 /api/v1/does-not-exist
check sse-anonymous 401 /api/v1/runs/00000000-0000-0000-0000-000000000000/stream -H 'accept: text/event-stream'
[ "$failures" = 0 ] || { echo "header check: $failures failure(s)" >&2; exit 1; }
echo "header check ok: $base"
