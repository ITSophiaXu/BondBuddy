# Private, immutable copies of both release records. Sourced by release entry points.
# No Docker, database, network or model operation belongs in this helper.
BB_RELEASE_EVIDENCE_DIR=''
cleanup_release_evidence() {
  [ -z "${BB_RELEASE_EVIDENCE_DIR:-}" ] || rm -rf -- "$BB_RELEASE_EVIDENCE_DIR"
}
verify_release_evidence() {
  local repo="$1" sha="$2" mode="${3:-verify}" releases_log="${4:-}" role="${5:-}"
  : "${BB_RELEASE_QUALITY_RECEIPT:?set BB_RELEASE_QUALITY_RECEIPT to passing quality evidence for this exact commit}"
  : "${BB_RELEASE_SMOKE_REPORT:?set BB_RELEASE_SMOKE_REPORT to a passing test:release report for this exact commit}"
  [ -z "${BB_RELEASE_EVIDENCE_DIR:-}" ] || { echo 'release evidence was already captured' >&2; return 2; }
  BB_RELEASE_EVIDENCE_DIR="$(mktemp -d)"
  chmod 700 "$BB_RELEASE_EVIDENCE_DIR"
  # Verify the copies, then retain these exact bytes through a potentially long build.
  cp -- "$BB_RELEASE_QUALITY_RECEIPT" "$BB_RELEASE_EVIDENCE_DIR/quality.json"
  cp -- "$BB_RELEASE_SMOKE_REPORT" "$BB_RELEASE_EVIDENCE_DIR/smoke.json"
  chmod 600 "$BB_RELEASE_EVIDENCE_DIR/"*.json
  local suffix=()
  case "$mode" in
    verify) ;;
    verify-rollback) suffix=("${releases_log:?rollback requires a successful deployment log}"); [ -z "$role" ] || suffix+=("$role");;
    *) echo 'invalid release evidence mode' >&2; return 2;;
  esac
  node "$repo/scripts/prospectus-quality-gate.mjs" "$mode" "$sha" "$BB_RELEASE_EVIDENCE_DIR/quality.json" "${suffix[@]}"
  node "$repo/scripts/release-smoke/verify.mjs" "$mode" "$sha" "$BB_RELEASE_EVIDENCE_DIR/smoke.json" "${suffix[@]}"
  BB_RELEASE_QUALITY_DIGEST="$(sha256sum "$BB_RELEASE_EVIDENCE_DIR/quality.json" | awk '{print $1}')"
  BB_RELEASE_SMOKE_DIGEST="$(sha256sum "$BB_RELEASE_EVIDENCE_DIR/smoke.json" | awk '{print $1}')"
}
save_release_evidence() {
  local sha="$1" state="$2"
  [ "$(sha256sum "$BB_RELEASE_EVIDENCE_DIR/quality.json" | awk '{print $1}')" = "$BB_RELEASE_QUALITY_DIGEST" ] &&
    [ "$(sha256sum "$BB_RELEASE_EVIDENCE_DIR/smoke.json" | awk '{print $1}')" = "$BB_RELEASE_SMOKE_DIGEST" ] || {
      echo 'verified release evidence changed before success was recorded' >&2; return 2;
    }
  mkdir -p "$state/quality" "$state/release-smoke"
  cp -- "$BB_RELEASE_EVIDENCE_DIR/quality.json" "$state/quality/$sha.json"
  cp -- "$BB_RELEASE_EVIDENCE_DIR/smoke.json" "$state/release-smoke/$sha.json"
}
