ARG BASE_IMAGE=bb-fc-worker-base:local
FROM ${BASE_IMAGE}

COPY --chown=node:node scripts/fc-codex-probe/server.mjs /opt/fc-codex-probe/server.mjs
COPY --chown=node:node scripts/local-integration/diagnose-file-sandbox.mjs /opt/fc-codex-probe/diagnose-file-sandbox.mjs

ENV PORT=9000
EXPOSE 9000
CMD ["node", "/opt/fc-codex-probe/server.mjs"]
