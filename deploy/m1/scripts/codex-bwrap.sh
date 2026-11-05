#!/bin/bash
# Pinned Codex 0.154.0 mounts proc after its filesystem deny masks. Reapply the
# /proc deny last, preserving the launcher's options and inherited descriptors.
set -euo pipefail
readonly genuine_bwrap=/opt/codex/codex-resources/bwrap

refuse() {
  printf 'BondBuddy bwrap hardening: unsupported invocation; refusing execution.\n' >&2
  exit 64
}

if [[ $# -eq 1 && ( $1 == --help || $1 == --version ) ]]; then
  exec "$genuine_bwrap" "$@"
fi

declare -a original_options=()
while (( $# )); do
  if [[ $1 == -- ]]; then
    shift
    (( $# )) || refuse
    exec "$genuine_bwrap" "${original_options[@]}" \
      --perms 000 --tmpfs /proc --remount-ro /proc -- "$@"
  fi
  # Consume option values explicitly: a value equal to "--" is not the command
  # separator. This is the option set of the bundled, integrity-pinned bwrap.
  case "$1" in
    --level-prefix|--unshare-all|--share-net|--unshare-user|--unshare-user-try|--unshare-ipc|--unshare-pid|--unshare-net|--unshare-uts|--unshare-cgroup|--unshare-cgroup-try|--disable-userns|--assert-userns-disabled|--clearenv|--new-session|--die-with-parent|--as-pid-1)
      arity=0 ;;
    --args|--argv0|--userns|--userns2|--pidns|--uid|--gid|--hostname|--chdir|--unsetenv|--lock-file|--sync-fd|--remount-ro|--overlay-src|--tmp-overlay|--ro-overlay|--exec-label|--file-label|--proc|--dev|--tmpfs|--mqueue|--dir|--seccomp|--add-seccomp-fd|--block-fd|--userns-block-fd|--info-fd|--json-status-fd|--cap-add|--cap-drop|--perms|--size)
      arity=1 ;;
    --setenv|--bind|--bind-try|--dev-bind|--dev-bind-try|--ro-bind|--ro-bind-try|--bind-fd|--ro-bind-fd|--file|--bind-data|--ro-bind-data|--symlink|--chmod)
      arity=2 ;;
    --overlay) arity=3 ;;
    *) refuse ;;
  esac
  (( $# > arity )) || refuse
  original_options+=("$1")
  shift
  for (( i=0; i<arity; i++ )); do
    original_options+=("$1")
    shift
  done
done
refuse
