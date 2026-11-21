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
COPY product-prototype/public/workpaper-entry.css product-prototype/public/
COPY product-prototype/public/upload-progress.css product-prototype/public/
COPY product-prototype/public/subscription-billing.css product-prototype/public/subscription-topup.css product-prototype/public/billing-price-admin.css product-prototype/public/payment-experience.css product-prototype/public/
COPY apps apps
# Web type checking includes opt-in local E2E imports; these synthetic config sources stay in the build stage.
COPY scripts/local-integration/config.mjs scripts/local-integration/config.d.mts scripts/local-integration/
# The web workspace imports these prototype stylesheets as its layout baseline (#361, M2).
COPY product-prototype/public/styles.css product-prototype/public/project-workspace.css product-prototype/public/credits.css product-prototype/public/material-results.css product-prototype/public/source-prospectus.css product-prototype/public/duplicate-upload-feedback.css product-prototype/public/optional-materials.css product-prototype/public/prospectus-panel.css product-prototype/public/file-generation-ux.css product-prototype/public/workpaper-entry.css product-prototype/public/project-entry.css product-prototype/public/workspace-typography.css product-prototype/public/workpaper-task.css product-prototype/public/
COPY product-prototype/public/navigation-responsive.css product-prototype/public/
COPY product-prototype/public/desktop-workspace-polish.css product-prototype/public/document-workspace.css product-prototype/public/
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
COPY knowledge/workpaper-templates/2026-10-27/ knowledge/workpaper-templates/2026-10-27/
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

# Official stable codex-cli for the contained business adapter.
# Only the static musl `codex` binary and the bundled bwrap are kept; the tarball is checked
# against the npm registry sha512 integrity. Credentials come from env only (never auth.json).
FROM ${NODE_IMAGE} AS codex
ARG CODEX_VERSION=0.169.0
ARG CODEX_INTEGRITY_LINUX_X64=sha512-o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww==
ARG CODEX_INTEGRITY_LINUX_ARM64=sha512-NZ/DaQUpcQmxmqee7Z9uC1rzw3GhSbooawcaTe1LN5Yk+WlinUKGdTXJgClRT/9ogQEEM9TWxYzvxPfj5G/xFg==
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
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV BB_RELEASE_SHA=${BB_RELEASE_SHA} HOST=0.0.0.0 PORT=3000 BB_UPLOAD_SPOOL_DIR=/var/lib/bondbuddy/upload-spool PATH=/opt/template-preview/bin:$PATH
# The API renders only allowlisted derivatives. Keep its Python dependencies
# independent of the model/worker runtime and never render an original directly.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libreoffice-writer fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=root:root /app/python/bondbuddy_template_preview.py /app/python/bondbuddy_template_redaction.py /app/python/template-preview-requirements.txt ./python/
RUN python3 -m venv /opt/template-preview && /opt/template-preview/bin/pip install --no-cache-dir -r python/template-preview-requirements.txt
# Disk-backed upload spool (compose mounts a volume here); a fresh named volume inherits this owner.
RUN mkdir -p /var/lib/bondbuddy/upload-spool && chown node:node /var/lib/bondbuddy/upload-spool && chmod 0700 /var/lib/bondbuddy/upload-spool
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD ["node","-e","fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","apps/api/dist/server.js"]

FROM node-runtime AS integrity-egress
ARG BB_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
USER node
EXPOSE 3129
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node","-e","const s=require('net').connect(3129,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"]
CMD ["node","apps/worker/dist/integrity-egress.js"]

# Confirmation needs only Node, trusted CA roots and the kernel spool lock.
# No model CLI, Python/OCR, browser or authentication helper is installed here.
FROM node-runtime AS upload-confirmation
ARG BB_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
ENV BB_RELEASE_SHA=${BB_RELEASE_SHA}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/bondbuddy/upload-confirmation \
 && chown node:node /var/lib/bondbuddy/upload-confirmation \
 && chmod 0700 /var/lib/bondbuddy/upload-confirmation
USER node
CMD ["node","apps/worker/dist/upload-confirmation-runtime.js"]

FROM node-runtime AS worker
COPY --chown=root:root deploy/tencent-elasticity/task-cgroups.mjs deploy/tencent-elasticity/task-cgroup-broker.py deploy/tencent-elasticity/task-cgroup-broker.profile deploy/tencent-elasticity/task-runner.py deploy/tencent-elasticity/task-chromium deploy/tencent-elasticity/
COPY --chown=root:root deploy/m1/security/codex-apparmor.profile deploy/m1/security/
COPY --chown=root:root deploy/tencent-elasticity/compose.yaml deploy/tencent-elasticity/
COPY --chown=root:root deploy/m1/security/integrity-browser-seccomp.json deploy/m1/security/codex-seccomp.json deploy/m1/security/
COPY --chown=root:root deploy/tencent-elasticity/policy.mjs deploy/tencent-elasticity/costcap.mjs deploy/tencent-elasticity/cloud-quote-refresh.mjs deploy/tencent-elasticity/tencent-cvm.mjs deploy/tencent-elasticity/controller.mjs deploy/tencent-elasticity/bootstrap.mjs deploy/tencent-elasticity/private-files.mjs deploy/tencent-elasticity/ops-handler.mjs deploy/tencent-elasticity/reconcile-entry.mjs deploy/tencent-elasticity/bootstrap-entry.mjs deploy/tencent-elasticity/enrollment.mjs deploy/tencent-elasticity/node-adapter.mjs deploy/tencent-elasticity/authoring-workspace.mjs deploy/tencent-elasticity/private-transport.mjs deploy/tencent-elasticity/private-egress.mjs deploy/tencent-elasticity/transport-issuer.mjs deploy/tencent-elasticity/transport-renewal.mjs deploy/tencent-elasticity/transport-refresher.mjs deploy/tencent-elasticity/transport-service.mjs deploy/tencent-elasticity/stunnel-reload.mjs deploy/tencent-elasticity/control-socket.mjs deploy/tencent-elasticity/control-authority.mjs deploy/tencent-elasticity/control-credentials.mjs deploy/tencent-elasticity/control-tick-bound.mjs deploy/tencent-elasticity/expense-history.mjs deploy/tencent-elasticity/cloud-tariff-refresh.mjs deploy/tencent-elasticity/enrollment-version.mjs deploy/tencent-elasticity/bootstrap-failure.mjs deploy/tencent-elasticity/business-overlay.mjs deploy/tencent-elasticity/
ARG BB_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/bondbuddy-browsers
RUN node node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /opt/bondbuddy-browsers
ARG BB_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
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
# Default adapter PATH resolves this immutable wrapper before any system bwrap.
# It calls only the integrity-pinned bundled binary and reapplies /proc deny last.
COPY --chown=root:root --chmod=0755 deploy/m1/scripts/codex-bwrap.sh /usr/local/bin/bwrap
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex && codex --version && /usr/local/bin/bwrap --version
COPY --chmod=0755 deploy/m1/scripts/copilot-token.mjs /usr/local/bin/bb-copilot-token
RUN install -d -m 0755 /opt/bondbuddy
COPY --chmod=0644 deploy/m1/codex-model-catalog.json /opt/bondbuddy/codex-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-image-model-catalog.json /opt/bondbuddy/codex-image-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-authoring-model-catalog.json /opt/bondbuddy/codex-authoring-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-file-authoring-model-catalog.json /opt/bondbuddy/codex-file-authoring-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-copilot-file-authoring-model-catalog.json /opt/bondbuddy/codex-copilot-file-authoring-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-deepseek-model-catalog.json /opt/bondbuddy/codex-deepseek-model-catalog.json
COPY --chmod=0644 deploy/m1/codex-deepseek-LICENSE.txt /opt/bondbuddy/codex-deepseek-LICENSE.txt
COPY --from=build --chown=root:root /app/python python
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r python/requirements.txt
COPY --chmod=0755 deploy/m1/scripts/verify-ocr-runtime.sh /usr/local/bin/bb-verify-ocr-runtime
COPY --chmod=0644 deploy/m1/scripts/ocr-worker-image-smoke.py /opt/bondbuddy/ocr-worker-image-smoke.py
RUN /usr/local/bin/bb-verify-ocr-runtime
# Mount point for the ops scheduler's NDJSON log sink; a fresh named volume inherits this ownership.
RUN mkdir -p /var/lib/bb-logs && chown node:node /var/lib/bb-logs && chmod 0700 /var/lib/bb-logs
# #17 disk-backed parse staging (BB_PARSE_STAGING_DIR); also inherited by a fresh named volume.
RUN mkdir -p /var/lib/bondbuddy/parse-staging && chown node:node /var/lib/bondbuddy/parse-staging && chmod 0700 /var/lib/bondbuddy/parse-staging
RUN install -d -o node -g node -m 0700 /var/lib/bondbuddy/authoring-state \
    /var/lib/bondbuddy/authoring-state/attempts /var/lib/bondbuddy/authoring-state/spool \
    /var/lib/bondbuddy/authoring-state/workflows
USER node
# #17 long-lived WorkerRuntime: leased parse/run slots, sweep, heartbeat (readiness) and, only with
# BB_PLATFORM_PROBE_ENABLED=1, the operator probe loop. PID 1 is node, so SIGTERM drains and releases leases.
CMD ["sh","-c","/usr/local/bin/bb-verify-ocr-runtime && exec node apps/worker/dist/runtime.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
ARG BB_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=${BB_RELEASE_SHA}
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY --from=build /app/deploy/m1/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/deploy/m1/nginx/security-headers.conf /etc/nginx/conf.d/snippets/security-headers.conf
EXPOSE 8080
