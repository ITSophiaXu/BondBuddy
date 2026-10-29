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

Docker was unavailable in the original Windows shell, so the checks above do **not** claim Docker Compose interpolation/merge execution, a release-image Node 22 probe, or real payment acceptance. A later check found the existing local BondBuddyM3 WSL Docker runtime; its separately recorded verification supersedes this initial environment limitation only for the checks actually run. On the release host, use the runbook command to pipe the fully merged `docker compose config --format json` directly into `scripts/check-payment-deployment.mjs`; do not record raw configuration output. The exact release image must separately pass the local CONNECT / unavailable proxy / NO_PROXY probe before merchant enablement.

The final integration additionally sets the API stop grace to90seconds and installs SIGTERM/SIGINT shutdown. Reconciliation stops starting further claimed records and preserves unfinished intents for later recovery. The9checker tests were rerun on the current local Node v26.13.0 and passed; the graceful-stop behaviour is covered by the synthetic payment reconciliation PG suite, not by a Docker shutdown test.

The current checker suite includes two later statement/Alipay configuration cases: **11/11 passed**, no skips, on Node v26.13.0; see `completion/deployment-checker-11-final.log`. This does not replace the exact-image runtime probe or merchant verification.

Follow-up packaging audit found that the subscription and price-admin CSS files were missing from the Docker context exceptions and explicit build-stage COPY list. Commit `e2773211da4c17a98195e9099ec3f1931be84b35` includes both styles and extends the existing asset test to discover CSS imports as well as direct TypeScript imports. The focused packaging test passed: `completion/deployment-css-assets-final.log`.

The first actual API image build then found missing build-stage inputs for Web E2E typechecking. Commit `279f13a0f086ca1048b38058fcc94703763f8b5a` copies only the required synthetic local configuration module and its declaration into the build stage; full typechecking remains enabled. Both dynamic packaging checks passed. The original Dockerfile API target subsequently built successfully on Linux, with Node v22.23.4 and image ID `sha256:1ecf1c3b12966ffa986716dfdde891d1d31b25f2bcdfa20fde4061c780d421d2`. The exact image passed all four isolated HTTPS proxy assertions. See [exact image evidence](RELEASE-API-LOCAL-VALIDATION.md) and [actual Compose matrix](WSL-LOCAL-DEPLOYMENT-VALIDATION.md).

The same API image also passed four worker JavaScript tests against newly migrated, isolated PostgreSQL/Azurite, and its actual API entry point returned HTTP200 from `/health`; see [runtime log](completion/m2-worker-isolated.log). This health endpoint proves only process/route startup. The full worker/OCR image, shutdown during real channel requests, production egress and merchant transactions remain separate acceptance items. These later results do not retroactively change the initial Windows test environment or historical logs.

Later browser verification found and fixed two workspace schema exports in the Web client. The updated production source `19241ef12ef0289468ec1cb9c72b653b014160ec` was therefore rebuilt separately: image `sha256:854478de05dc26f5c91c51470dbe76ac129e87d0579f0e3700c325c1dd326cda`, Node v22.23.4, matching runtime and OCI source identities. All workspace builds passed. See [updated image evidence](RELEASE-API-19241ef12ef0-VALIDATION.md). This new image received an isolated identity probe; the earlier proxy and worker test results remain bound to the earlier image, rather than being relabeled as rerun results.
