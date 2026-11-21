ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
COPY --chown=root:root --chmod=0644 apps/worker/dist/ /app/apps/worker/dist/
COPY --chown=root:root --chmod=0644 apps/api/dist/ /app/apps/api/dist/
COPY --chown=root:root --chmod=0644 deploy/tencent-elasticity/node-adapter.mjs deploy/tencent-elasticity/business-overlay.mjs deploy/tencent-elasticity/task-cgroups.mjs deploy/tencent-elasticity/task-cgroup-broker.py deploy/tencent-elasticity/task-cgroup-broker.profile deploy/tencent-elasticity/task-runner.py deploy/tencent-elasticity/task-chromium deploy/tencent-elasticity/compose.yaml /app/deploy/tencent-elasticity/
COPY --chown=root:root --chmod=0644 deploy/m1/security/codex-apparmor.profile /app/deploy/m1/security/
COPY --chown=root:root --chmod=0644 deploy/tencent-elasticity/task-runner.py /opt/bondbuddy/task-runner.py
COPY --chown=root:root --chmod=0755 deploy/tencent-elasticity/task-chromium /opt/bondbuddy/task-chromium
RUN chmod 0755 /app/apps/worker/dist /app/apps/api/dist /app/deploy/tencent-elasticity /app/deploy/m1/security \
 && node --input-type=module -e "import {chromium} from 'playwright';import {symlinkSync} from 'node:fs';symlinkSync(chromium.executablePath(),'/opt/bondbuddy/task-chromium-real');"
USER node
LABEL bondbuddy.test-only="task-cgroups-synthetic"
