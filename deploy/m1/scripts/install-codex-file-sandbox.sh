#!/usr/bin/env bash
set -euo pipefail
security="$(cd "$(dirname "$0")/../security" && pwd)"
test -r "$security/codex-apparmor.profile"
test -r "$security/codex-seccomp.json"
# The image installs this reviewed source as root-owned /usr/local/bin/bwrap;
# never replace the deployment host's bwrap or relax its security profiles.
wrapper="$(dirname "$security")/scripts/codex-bwrap.sh"
test -r "$wrapper"
/bin/bash -n "$wrapper"
command -v apparmor_parser >/dev/null || { echo 'Codex file authoring requires AppArmor tools on the Linux deployment host' >&2; exit 1; }
if [ "$(id -u)" -eq 0 ]; then
  install -o root -g root -m 0644 "$security/codex-apparmor.profile" /etc/apparmor.d/bondbuddy-codex-v1
  apparmor_parser -r /etc/apparmor.d/bondbuddy-codex-v1
else
  sudo install -o root -g root -m 0644 "$security/codex-apparmor.profile" /etc/apparmor.d/bondbuddy-codex-v1
  sudo apparmor_parser -r /etc/apparmor.d/bondbuddy-codex-v1
fi
