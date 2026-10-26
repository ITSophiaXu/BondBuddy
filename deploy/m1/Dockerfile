# syntax=docker/dockerfile:1.7
# M1 images. Build context is the repository root at an exact commit (deploy.sh uses `git archive <sha>`).
# Targets: api (also runs migrations and blob backup), worker (Node + Python 3.11 parser + pinned codex-cli), web (nginx + static build).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/rule-pack-registry/package.json packages/rule-pack-registry/
COPY packages/rule-applicability-context/package.json packages/rule-applicability-context/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
# The web workspace imports these prototype stylesheets as its layout baseline (#361, M2).
COPY product-prototype/public/styles.css product-prototype/public/project-workspace.css product-prototype/public/credits.css product-prototype/public/material-results.css product-prototype/public/source-prospectus.css product-prototype/public/duplicate-upload-feedback.css product-prototype/public/optional-materials.css product-prototype/public/prospectus-panel.css product-prototype/public/
# Copy only the pinned public research assets, never source documents or test materials.
COPY knowledge/exchange-bonds/drafts/sse-private/rule-pack.json knowledge/exchange-bonds/drafts/sse-private/chapter-template.json knowledge/exchange-bonds/drafts/sse-private/coverage.json knowledge/exchange-bonds/drafts/sse-private/
COPY knowledge/exchange-bonds/drafts/ knowledge/exchange-bonds/drafts/
COPY knowledge/exchange-bonds/共通方法与差异.md knowledge/exchange-bonds/冲突与未覆盖项.md knowledge/exchange-bonds/
COPY knowledge/nafmii/APPLICABILITY.md knowledge/nafmii/APPLICABILITY.md
COPY knowledge/nafmii/drafts/ knowledge/nafmii/drafts/
COPY product-prototype/knowledge/*-review.md product-prototype/knowledge/
COPY knowledge/audit-reconciliation/METHODS.md knowledge/audit-reconciliation/METHODS.md
COPY knowledge/material-drafting/2026-10-07/catalog.json knowledge/material-drafting/2026-10-07/catalog.json
COPY knowledge/material-drafting/2026-10-07/packs/ knowledge/material-drafting/2026-10-07/packs/
COPY knowledge/material-drafting/2026-10-15/catalog.json knowledge/material-drafting/2026-10-15/catalog.json
COPY knowledge/material-drafting/2026-10-15/templates/ knowledge/material-drafting/2026-10-15/templates/
RUN npm run build && node apps/worker/dist/verify-sse-private-candidate-assets.js \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf apps/*/src apps/web/tests apps/web/node_modules packages/*/src
COPY db db
COPY deploy/m1/config/review-prices-20261009.json deploy/m1/config/review-prices-20261009.json
COPY python python
COPY deploy/m1/scripts/blob-snapshot.mjs deploy/m1/scripts/backup-offhost.mjs deploy/m1/scripts/backup-stream.mjs deploy/m1/scripts/
COPY deploy/m1/nginx/default.conf deploy/m1/nginx/security-headers.conf deploy/m1/nginx/
# Normalise permissions regardless of the build host's umask; the runtime user only reads.
RUN find /app/python -name __pycache__ -prune -exec rm -rf {} + \
 && find /app -type d ! -perm -005 -exec chmod a+rx {} + \
 && find /app -type f ! -perm -004 -exec chmod a+r {} + \
 && find /app -perm /022 -exec chmod go-w {} +

# Pinned codex-cli for the #16 contained adapter (same version as the #16 live probes).
# Only the static musl `codex` binary and the bundled bwrap are kept; the tarball is checked
# against the npm registry sha512 integrity. Credentials come from env only (never auth.json).
FROM ${NODE_IMAGE} AS codex
ARG CODEX_VERSION=0.154.0
ARG CODEX_INTEGRITY_LINUX_X64=sha512-a4FI3A8sGtwGrOqltrPbrS2hajrHQG591EwmRfiRoLMb10VxdBtUGW4gu6IJVYENiYGA7k3P4jlRHEoCZU/s9Q==
ARG CODEX_INTEGRITY_LINUX_ARM64=sha512-KmTCB6ST484zeYlPpKP/K5P/gRaYmt6TihVD+zotoe6O9q0JSBP+FYvCz4A/zZXR7xDOHURTSjHp0sD8wWS0YQ==
ARG TARGETARCH
WORKDIR /tmp/codex
RUN set -eu; \
 case "${TARGETARCH:-amd64}" in \
   amd64) pkg=linux-x64; triple=x86_64-unknown-linux-musl; want="$CODEX_INTEGRITY_LINUX_X64" ;; \
   arm64) pkg=linux-arm64; triple=aarch64-unknown-linux-musl; want="$CODEX_INTEGRITY_LINUX_ARM64" ;; \
   *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
 esac; \
 npm pack "@openai/codex@${CODEX_VERSION}-${pkg}" --silent >/dev/null; \
 tgz="openai-codex-${CODEX_VERSION}-${pkg}.tgz"; \
 got="sha512-$(node -e "process.stdout.write(require('crypto').createHash('sha512').update(require('fs').readFileSync(process.argv[1])).digest('base64'))" "$tgz")"; \
 [ "$got" = "$want" ] || { echo "codex tarball integrity mismatch" >&2; exit 1; }; \
 tar xzf "$tgz"; v="package/vendor/$triple"; \
 install -d -m 0755 /opt/codex/bin /opt/codex/codex-resources; \
 install -m 0755 "$v/bin/codex" /opt/codex/bin/codex; \
 install -m 0755 "$v/codex-resources/bwrap" /opt/codex/codex-resources/bwrap; \
 install -m 0644 "$v/codex-package.json" /opt/codex/codex-package.json; \
 [ "$(/opt/codex/bin/codex --version)" = "codex-cli ${CODEX_VERSION}" ]; \
 rm -rf /tmp/codex /root/.npm

FROM ${NODE_IMAGE} AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules node_modules
COPY --from=build --chown=root:root /app/packages packages
COPY --from=build --chown=root:root /app/apps/api apps/api
COPY --from=build --chown=root:root /app/apps/worker apps/worker
COPY --from=build --chown=root:root /app/db db
COPY --from=build --chown=root:root /app/deploy/m1/config/review-prices-20261009.json deploy/m1/config/review-prices-20261009.json
COPY --from=build --chown=root:root /app/knowledge knowledge
COPY --from=build --chown=root:root /app/product-prototype/knowledge product-prototype/knowledge
COPY --from=build --chown=root:root /app/deploy/m1/scripts/blob-snapshot.mjs deploy/m1/scripts/blob-snapshot.mjs
COPY --from=build --chown=root:root /app/deploy/m1/scripts/backup-offhost.mjs deploy/m1/scripts/backup-offhost.mjs
COPY --from=build --chown=root:root /app/deploy/m1/scripts/backup-stream.mjs deploy/m1/scripts/backup-stream.mjs

FROM node-runtime AS api
ARG BB_RELEASE_SHA=unknown
ENV BB_RELEASE_SHA=${BB_RELEASE_SHA} HOST=0.0.0.0 PORT=3000 BB_UPLOAD_SPOOL_DIR=/var/lib/bondbuddy/upload-spool
# Disk-backed upload spool (compose mounts a volume here); a fresh named volume inherits this owner.
RUN mkdir -p /var/lib/bondbuddy/upload-spool && chown node:node /var/lib/bondbuddy/upload-spool && chmod 0700 /var/lib/bondbuddy/upload-spool
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD ["node","-e","fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","apps/api/dist/server.js"]

FROM node-runtime AS integrity-egress
USER node
EXPOSE 3129
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node","-e","const s=require('net').connect(3129,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"]
CMD ["node","apps/worker/dist/integrity-egress.js"]

FROM node-runtime AS worker
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/bondbuddy-browsers
RUN node node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /opt/bondbuddy-browsers
ARG BB_RELEASE_SHA=unknown
ENV BB_RELEASE_SHA=${BB_RELEASE_SHA} PATH=/opt/venv/bin:$PATH \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
# Bookworm OCR engine and language data are pinned independently; osd is used on every page.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates util-linux libreoffice-writer fonts-noto-cjk \
      xvfb xauth x11-utils openbox dbus-x11 xfdesktop4 xfce4-panel wmctrl scrot \
      tesseract-ocr=5.3.0-2 \
      tesseract-ocr-eng=1:4.1.0-2 \
      tesseract-ocr-chi-sim=1:4.1.0-2 \
      tesseract-ocr-osd=1:4.1.0-2 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=codex --chown=root:root /opt/codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex && codex --version
COPY --chmod=0755 deploy/m1/scripts/copilot-token.mjs /usr/local/bin/bb-copilot-token
RUN install -d -m 0755 /opt/bondbuddy
COPY --chmod=0644 deploy/m1/codex-model-catalog.json /opt/bondbuddy/codex-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-authoring-model-catalog.json /opt/bondbuddy/codex-authoring-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-file-authoring-model-catalog.json /opt/bondbuddy/codex-file-authoring-model-catalog.json
COPY --from=build --chown=root:root /app/python python
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r python/requirements.txt
COPY --chmod=0755 deploy/m1/scripts/verify-ocr-runtime.sh /usr/local/bin/bb-verify-ocr-runtime
COPY --chmod=0644 deploy/m1/scripts/ocr-worker-image-smoke.py /opt/bondbuddy/ocr-worker-image-smoke.py
RUN /usr/local/bin/bb-verify-ocr-runtime
# Mount point for the ops scheduler's NDJSON log sink; a fresh named volume inherits this ownership.
RUN mkdir -p /var/lib/bb-logs && chown node:node /var/lib/bb-logs && chmod 0700 /var/lib/bb-logs
# #17 disk-backed parse staging (BB_PARSE_STAGING_DIR); also inherited by a fresh named volume.
RUN mkdir -p /var/lib/bondbuddy/parse-staging && chown node:node /var/lib/bondbuddy/parse-staging && chmod 0700 /var/lib/bondbuddy/parse-staging
USER node
# #17 long-lived WorkerRuntime: leased parse/run slots, sweep, heartbeat (readiness) and, only with
# BB_PLATFORM_PROBE_ENABLED=1, the operator probe loop. PID 1 is node, so SIGTERM drains and releases leases.
CMD ["sh","-c","/usr/local/bin/bb-verify-ocr-runtime && exec node apps/worker/dist/runtime.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY --from=build /app/deploy/m1/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/deploy/m1/nginx/security-headers.conf /etc/nginx/conf.d/snippets/security-headers.conf
EXPOSE 8080
