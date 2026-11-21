FROM node:22-bookworm-slim
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN apt-get update && apt-get install -y --no-install-recommends python3 tini \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -c "import uuid; open('/etc/machine-id', 'w').write(uuid.uuid4().hex + '\n')"
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/rule-pack-registry/package.json packages/rule-pack-registry/
COPY packages/rule-applicability-context/package.json packages/rule-applicability-context/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
COPY packages/ packages/
COPY apps/api/dist/ apps/api/dist/
COPY apps/worker/dist/ apps/worker/dist/
COPY apps/worker/src/fixtures/ apps/worker/src/fixtures/
COPY deploy/tencent-elasticity/task-runner.py /opt/bondbuddy/task-runner.py
RUN chmod -R a+rX /app/packages /app/apps && chmod 0644 /opt/bondbuddy/task-runner.py
USER node
LABEL bondbuddy.test-only="worker-barrier-synthetic"
