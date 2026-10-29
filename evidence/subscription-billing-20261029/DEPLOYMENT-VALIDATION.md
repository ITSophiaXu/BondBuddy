# Payment deployment configuration checks

2026-10-29. Local, synthetic configuration checks only. No merchant credential was read, no provider request was sent, and no deployment was performed.

The API now receives `NODE_USE_ENV_PROXY=1`, matching uppercase/lowercase HTTPS proxy and bypass variables, and an egress startup dependency while remaining on the internal backend network. API, all worker groups and ops receive the same subscription switch, defaulting to `0`. The default allow-list remains `api.deepseek.com`; the environment example documents the exact extra WeChat hostname only for an enabled merchant configuration.

`node --test scripts/check-payment-deployment.test.mjs`: **9/9 passed**, using local Node **v24.22.1**. These checks cover a missing worker switch, absent Node proxy opt-in, case mismatch, a merchant bypass, missing exact merchant host, wildcard/suffix/URL host entries, accidental API internet attachment, missing egress dependency, and redaction of configuration/parser failures.

The four checked-in Compose files were parsed with the YAML parser already bundled in the installed Playwright dependency (`playwright-core/lib/utilsBundle.js`, `yaml.parseDocument`, merge keys enabled, `!override` sequence tag recognized). Only synthetic required variables were substituted; relevant mapping overrides were combined in order. No private `.env` file was read.

| Source configuration | Default payment/billing off | Explicit payment/billing on with exact WeChat host |
|---|---|---|
| Base | 8/8 checks passed | 8/8 checks passed |
| Base + prod | 8/8 checks passed | 8/8 checks passed |
| Base + prod + integrity-browser | 8/8 checks passed | 8/8 checks passed |
| Base + prod + integrity-beijing | 8/8 checks passed | 8/8 checks passed |

Enabling WeChat without adding `api.mch.weixin.qq.com` was separately checked and rejected. Both optional integrity overlays preserve the API and worker subscription switch.

Docker is unavailable in this local shell, so this evidence does **not** claim Docker Compose interpolation/merge execution, a release-image Node 22 probe, or real payment acceptance. On the release host, use the runbook command to pipe the fully merged `docker compose config --format json` directly into `scripts/check-payment-deployment.mjs`; do not record raw configuration output. The exact release image must separately pass the local CONNECT / unavailable proxy / NO_PROXY probe before merchant enablement.

The final integration additionally sets the API stop grace to90seconds and installs SIGTERM/SIGINT shutdown. Reconciliation stops starting further claimed records and preserves unfinished intents for later recovery. The9checker tests were rerun on the current local Node v26.13.0 and passed; the graceful-stop behaviour is covered by the synthetic payment reconciliation PG suite, not by a Docker shutdown test.
