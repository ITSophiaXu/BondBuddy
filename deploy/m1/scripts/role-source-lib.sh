# Exact commits must be reachable from the designated repository, never only local objects.
BB_RELEASE_VALIDATOR_PATHS=(scripts/prospectus-quality-gate.mjs scripts/release-smoke/verify.mjs scripts/release-smoke/support.mjs)
role_trusted_source() {
  local sha="$1" ref trusted=0
  case "$(git -C "$BB_REPO" remote get-url origin)" in
    https://github.com/ITSophiaXu/BondBuddy.git|git@github.com:ITSophiaXu/BondBuddy.git) ;;
    *) echo 'origin must be the trusted BondBuddy repository' >&2; exit 2;;
  esac
  while read -r ref; do
    if git -C "$BB_REPO" merge-base --is-ancestor "$sha" "$ref"; then trusted=1; break; fi
  done < <(git -C "$BB_REPO" for-each-ref --format='%(refname)' refs/remotes/origin/)
  [ "$trusted" = 1 ] || { echo 'commit is not reachable from fetched origin history' >&2; exit 2; }
}
role_script_source() {
  local source_status
  BB_SCRIPT_SHA="$(git -C "$BB_REPO" rev-parse --verify HEAD^{commit})"
  [ -z "$BB_DEPLOY_SCRIPT_SHA" ] || [ "$BB_DEPLOY_SCRIPT_SHA" = "$BB_SCRIPT_SHA" ] || { echo 'checkout must match BB_DEPLOY_SCRIPT_SHA' >&2; exit 2; }
  role_trusted_source "$BB_SCRIPT_SHA"
  git -C "$BB_REPO" ls-files --error-unmatch -- "${BB_RELEASE_VALIDATOR_PATHS[@]}" >/dev/null || { echo 'release evidence validators must belong to the script commit' >&2; exit 2; }
  source_status="$(git -C "$BB_REPO" status --porcelain --untracked-files=all -- deploy/m1 "${BB_RELEASE_VALIDATOR_PATHS[@]}")" || { echo 'cannot verify deployment and evidence-validator source state' >&2; exit 2; }
  [ -z "$source_status" ] || { echo 'deployment directory must be clean at the script commit, including release evidence validators' >&2; exit 2; }
}
