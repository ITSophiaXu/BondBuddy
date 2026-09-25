#!/usr/bin/env bash
# Usage: smoke.sh <base-url>   Checks health, SPA, anonymous API denial, headers and bundle hygiene.
set -euo pipefail
base="${1:?usage: smoke.sh <base-url>}"; base="${base%/}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
code() { curl -sS -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' "$@"; }
for i in $(seq 1 30); do [ "$(code "$base/healthz" || true)" = 200 ] && break; sleep 2; done
grep -q '"status":"ok"' "$tmp/body" || fail "/healthz not ok"
[ "$(code "$base/")" = 200 ] || fail "/ not 200"
cp "$tmp/body" "$tmp/index.html"
grep -qi '<script' "$tmp/index.html" || fail "/ is not the web app"
grep -qi '^x-content-type-options: nosniff' "$tmp/headers" || fail "missing nosniff"
grep -qi '^content-security-policy:' "$tmp/headers" || fail "missing CSP"
grep -qi '^server: .*[0-9]' "$tmp/headers" && fail "server version exposed"
[ "$(code "$base/api/v1/me")" = 401 ] || fail "/api/v1/me should be 401 anonymously"
for asset in $(grep -o '/assets/[^"]*\.js' "$tmp/index.html" || true); do
  curl -sS "$base$asset" -o "$tmp/asset.js"
  grep -Eq 'sk-[A-Za-z0-9]{16,}|DEEPSEEK_API_KEY|AccountKey=|BB_CODEX_' "$tmp/asset.js" && fail "secret-like string in $asset"
done
echo "smoke ok: $base"
