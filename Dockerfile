FROM node:22-bookworm-slim

ARG CODEX_VERSION=latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BOND_HOST=0.0.0.0 \
    PORT=8000 \
    BOND_CODEX_PATH=/usr/local/bin/codex \
    BOND_DATA_DIR=/data/projects \
    BOND_CODEX_HOME=/data/codex \
    CODEX_HOME=/data/codex \
    BOND_CODEX_LINUX_SANDBOX=legacy_landlock \
    BOND_OCR=off \
    BOND_DEMO=0

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY web ./web
COPY ["outputs/上交所私募公司债财务数据更新规则_专家审阅版.md", "./outputs/上交所私募公司债财务数据更新规则_专家审阅版.md"]
COPY docker-entrypoint.sh .

RUN useradd --create-home --uid 10001 bond \
    && mkdir -p /data/projects /data/codex /data/worker-codex /data/conversations /data/job-lock \
    && sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && chown -R bond:bond /app /data \
    && chmod 0755 /app/docker-entrypoint.sh

USER bond

EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
