# syntax=docker/dockerfile:1.7
# M1 images. Build context is the repository root at an exact commit (deploy.sh uses `git archive <sha>`).
# Targets: api (also runs migrations and blob backup), worker (Node + Python 3.11 parser), web (nginx + static build).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf apps/*/src apps/web/tests apps/web/node_modules packages/*/src
COPY db db
COPY python python
COPY deploy/m1/scripts/blob-snapshot.mjs deploy/m1/scripts/worker-loop.sh deploy/m1/scripts/
COPY deploy/m1/nginx/default.conf deploy/m1/nginx/security-headers.conf deploy/m1/nginx/
# Normalise permissions regardless of the build host's umask; the runtime user only reads.
RUN find /app/python -name __pycache__ -prune -exec rm -rf {} + ; chmod -R a+rX,go-w /app && chmod 0755 deploy/m1/scripts/worker-loop.sh

FROM ${NODE_IMAGE} AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/node_modules node_modules
COPY --from=build --chown=root:root /app/packages packages
COPY --from=build --chown=root:root /app/apps/api apps/api
COPY --from=build --chown=root:root /app/apps/worker apps/worker
COPY --from=build --chown=root:root /app/db db
COPY --from=build --chown=root:root /app/deploy/m1/scripts/blob-snapshot.mjs deploy/m1/scripts/blob-snapshot.mjs

FROM node-runtime AS api
ARG BB_RELEASE_SHA=unknown
ENV BB_RELEASE_SHA=${BB_RELEASE_SHA} HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD ["node","-e","fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node","apps/api/dist/server.js"]

FROM node-runtime AS worker
ARG BB_RELEASE_SHA=unknown
ENV BB_RELEASE_SHA=${BB_RELEASE_SHA} PATH=/opt/venv/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=root:root /app/python python
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r python/requirements.txt
COPY --from=build --chown=root:root /app/deploy/m1/scripts/worker-loop.sh /usr/local/bin/worker-loop
USER node
CMD ["worker-loop"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY --from=build /app/deploy/m1/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/deploy/m1/nginx/security-headers.conf /etc/nginx/conf.d/snippets/security-headers.conf
EXPOSE 8080
