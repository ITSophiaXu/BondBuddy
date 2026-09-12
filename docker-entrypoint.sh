#!/bin/sh
set -eu

mkdir -p "${BOND_DATA_DIR}" "${CODEX_HOME}"

if [ ! -f "${CODEX_HOME}/config.toml" ]; then
    printf '%s\n' 'cli_auth_credentials_store = "file"' > "${CODEX_HOME}/config.toml"
fi

if [ -n "${OPENAI_API_KEY:-}" ]; then
    printf '%s' "${OPENAI_API_KEY}" | codex login --with-api-key >/tmp/codex-login.log 2>&1
    unset OPENAI_API_KEY
fi

exec python -X utf8 -m backend.server \
    --host "${BOND_HOST:-0.0.0.0}" \
    --port "${PORT:-8000}" \
    --no-demo
