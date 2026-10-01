#!/usr/bin/env bash
# Usage: grant-operator.sh <username> <log_reader|log_operator|prompt_viewer> <reason_code> [granted_by]
# Maintenance-session grant for the #79 admin log routes (there is deliberately no HTTP route).
# Grants are append-only; revoke with: UPDATE bb_operator_grants SET revoked_at=now() WHERE id=...
source "$(dirname "$0")/lib.sh"
user="${1:?username}"; role="${2:?role}"; reason="${3:?reason_code}"; by="${4:-$(id -un)@$(hostname)}"
case "$role" in log_reader|log_operator|prompt_viewer) ;; *) echo "bad role" >&2; exit 2;; esac
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
compose exec -T postgres psql -U bondbuddy -d bondbuddy -v ON_ERROR_STOP=1 -At \
  -v u="$user" -v r="$role" -v why="$reason" -v by="$by" <<'SQL'
INSERT INTO bb_operator_grants(id,user_id,role,granted_by,reason_code)
SELECT gen_random_uuid()::text, id, :'r', :'by', :'why' FROM bb_users WHERE username=lower(:'u') AND status='active'
RETURNING id;
SQL
