#!/bin/sh
set -eu
# No shell evaluation of destination values or caller-supplied SSH arguments.
case "$BB_PG_SSH_HOST" in ''|-*|*[!a-zA-Z0-9._:-]*) exit 2;; esac
case "$BB_PG_SSH_USER" in ''|-*|*[!a-zA-Z0-9_-]*) exit 2;; esac
for port in "$BB_PG_SSH_PORT" "$BB_PG_FORWARD_PORT"; do
  case "$port" in ''|*[!0-9]*) exit 2;; esac
  [ "$port" -gt 0 ] && [ "$port" -le 65535 ] || exit 2
done
exec ssh -NT -F /dev/null -i /run/pg-ssh/key \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/run/pg-ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 -o LogLevel=ERROR \
  -p "$BB_PG_SSH_PORT" -L "0.0.0.0:5432:127.0.0.1:$BB_PG_FORWARD_PORT" \
  "$BB_PG_SSH_USER@$BB_PG_SSH_HOST"
