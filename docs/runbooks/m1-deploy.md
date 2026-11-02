# M1 deployment runbook (#35)

Everything lives in `deploy/m1/`. This runbook covers target-host requirements, first install, deploy, rollback, legacy restore tooling and TLS. It does not replace the release record: every production deploy, rollback and restore is logged in `deploy/m1/state/releases.log` on the host, and must also be noted on the release Issue/PR with the commit, migrations, verification and rollback plan. From 2026-09-29, releases and the host schedule do not create new backups by project-owner decision. Existing backups remain subject to the configured retention policy.

## Mandatory prospectus quality gate (2026-11-01)

Before a release or image export, run `npm run quality:prospectus` on the exact clean Linux candidate checkout and set `BB_RELEASE_QUALITY_RECEIPT` to the resulting `.local/prospectus-quality.json`. The scripts reject missing, failed, skipped, expired, or different-commit/tree evidence before release effects, including when all images are preloaded. Every image must carry the matching full `org.opencontainers.image.revision` label. Run again for the final merge commit; PR evidence cannot authorize a different release SHA. Emergency rollback may reuse an expired original pass only when its full commit and receipt SHA256 match the successful deployment record in `state/releases.log`; use the preserved `state/quality/<full-sha>.json`. See [policy and commands](../product-decisions/2026-11-01-prospectus-quality-gate.md), including the current GitHub billing/branch-protection limitations. Manual Docker commands outside these entry points remain an administrative bypass and must not be used as the release path.

The fixed gate includes the independent `api-source-selection` PostgreSQL regressions for adopted originals, exact version/hash/template locks and automatic adoption. Its own complete TAP summary must show zero failures, cancellations, skips and TODOs. Release and rollback verification reject receipts that omit this check or its summary, including older receipts issued before this check was required.

Full release authorization also requires `BB_PROSPECTUS_ACCEPTANCE_FILE`: a trusted private real-model golden-case acceptance for the current commit/tree, including locked source/input/output hashes and independent financial, chapter and rendered-output verification. Missing evidence fails the final required check; synthetic responses cannot satisfy it. Hosted CI runs `validate` as `prospectus-quality-mechanical` and never issues a release receipt. A controlled Linux publisher runs the complete gate and exact-SHA verification, then supplies the separate `prospectus-release-acceptance` status. Both checks are required; mechanical success alone cannot authorize release. Never upload customer documents or the private acceptance file as GitHub artifacts.

Use `node scripts/publish-prospectus-quality.mjs <full-candidate-sha>` only on the controlled publisher after independent review, with the private evidence and disposable database configured as above. It posts pending first and success only after full `run` and `verify`; failures post failure and stop. See [publisher identity and private evidence procedure](../../scripts/prospectus-quality-publisher.md). Configure required checks to trust the dedicated release App/service identity. PR head, synthetic merge, merge queue and final master SHAs are distinct; repeat full acceptance for the actual deployed commit. Missing required-check permissions, GitHub billing or status-update failures are blockers, never permission to mark release accepted.

## Stack services

| service | image | notes |
|---|---|---|
| `postgres` | `postgres:16` | named volume `pgdata`; only on the internal `backend` network |
| `azurite` | Azurite 3.35 | **staging only** (`COMPOSE_PROFILES=staging-blob`). Production omits it and sets `AZURE_STORAGE_CONNECTION_STRING` to the private Azure Blob account. |
| `migrate` | `bondbuddy-m1-api:<sha>` | one-shot `node db/migrate.mjs`; `api` and `worker` start only after it exits 0 |
| `api` | `bondbuddy-m1-api:<sha>` | Fastify on :3000, non-root, read-only rootfs, trusts forwarded headers only from the nginx container address |
| `worker` | `bondbuddy-m1-worker:<sha>` | Node 22 + Python 3.11 venv; this source starts the leased WorkerRuntime as PID 1. Pre-production release `3506c9a40983` still uses the old parse loop until a new release is deployed. |
| `egress` | `bondbuddy-m1-egress:<sha>` | squid allow-list forward proxy, the **only** route out of `backend` |
| `web` | `bondbuddy-m1-web:<sha>` | unprivileged nginx on :8080: static web build at `/`, `/api/v1/` → api, `/healthz` → api `/health` |

`backend` is a Docker `internal` network (no gateway). API, workers and ops get `HTTPS_PROXY=http://egress:3128`; squid only accepts `CONNECT host:443` for names in `BB_EGRESS_ALLOW` (default `api.deepseek.com`). In production add the Blob host, for example `BB_EGRESS_ALLOW=api.deepseek.com,<account>.blob.core.windows.net`. `scripts/egress-test.sh` proves the policy from inside the worker container: direct TCP fails, non-listed hosts get 403, the provider host gets a tunnel (closed at once; no TLS or model request is sent).

### Subscription billing and payment egress

`BB_SUBSCRIPTION_BILLING_ENABLED` defaults to `0` and is shared by API, authoring/review/parse workers and ops. Keep it off until the same release and all its migrations (including subscription, price-version and recovery migrations 0131–0137) are installed and verified. The production and optional integrity overlays inherit this flag. It is independent of merchant configuration. WeChat Native checkout purchases one subscription period; it does not authorize recurring deductions from the customer's payment account.

The file-check coverage extension also requires migration **0144** and its matching worker. Stop the old run workers before migrating, then start the new API/workers from the same release; do not roll old and new worker versions together. The migration preserves existing immutable coverage records and exposes the old `bb_workpaper_check_evidence` name as a read compatibility view. That view is **not** compatible with the old worker's `INSERT ... ON CONFLICT` statement. Rollback must use a worker compatible with the new schema; do not simply start the old image. Accepted quotes and wallet records are retained. Verify restart of a completed model result and its already-persisted coverage before enabling new tasks.

The API recovers existing payment and refund intents every 60 seconds, with per-record backoff up to one hour and database claims across replicas. It also processes authorised refunds whose hold committed before the first dispatch. A configured refund adapter may retry the same immutable refund request only with a documented channel idempotency guarantee; WeChat uses the original `out_refund_no`, transaction and amount. Unknown responses retain the hold. This is intent recovery, not channel statement download or next-day statement reconciliation.

Unresolved payment queries, invalid refund receipts, and refunds still unresolved after three scheduled attempts raise an hourly-deduplicated `payment_reconciliation_unresolved` warning in the existing operator alerts view. Its detail contains only intent kind/ID, provider and attempt count. Resolve against the original payment/refund facts; do not edit wallet balances or create a new channel refund number to clear a warning. An alert is a historical event, so check the current original-order state before taking action.

API SIGTERM/SIGINT triggers Fastify close: reconciliation stops starting subsequent rows, waits for in-flight work and then closes a server-owned database pool. The base API service grants 90 seconds before forced termination. Rows not completed remain scheduled in PostgreSQL; a forced kill must not be interpreted as payment/refund failure. Real release-image/container shutdown and merchant acceptance still require a release-host check.

API and ops set `NODE_USE_ENV_PROXY=1` as well as both uppercase/lowercase `HTTPS_PROXY` and `NO_PROXY`. Merely choosing a `node:22` tag is insufficient: the release baseline for the current Node 22 images is **22.23.3 or later within the 22.x line**, followed by a local proxy probe using the exact release image. This baseline uses the already recorded 22.23.3 proxy rehearsal; it is not a claim that every Node 22 version supports environment proxies. Record `node --version` and the image digest. The probe must observe an HTTPS CONNECT through a local recording proxy, reject an unreachable proxy without falling back to a direct connection, and honor the internal/loopback `NO_PROXY` entries. The existing `Node 22 environment HTTPS proxy` case in `apps/worker/src/library-sources.test.ts` exercises those three behaviors with synthetic local servers. Do not use a merchant transaction as this runtime probe.

When enabling `BB_WECHAT_PAY_ENABLED=1`, append the exact host `api.mch.weixin.qq.com` to the existing `BB_EGRESS_ALLOW` list, for example `api.deepseek.com,<account>.blob.core.windows.net,api.mch.weixin.qq.com`. Keep existing approved Blob/model hosts. Do not use a wildcard, a suffix such as `.weixin.qq.com`, or add the merchant host to `BB_NO_PROXY`. No payment domain is opened by default. API stays on `backend` only and depends on the allow-list egress service. API callbacks still require the separately configured public HTTPS notify route.

Before release, validate the fully merged Compose configuration, including any optional overlay, without printing private environment values. From the repository root, pipe Compose's JSON directly to the redacted checker:

```sh
docker compose --env-file deploy/m1/.env -f deploy/m1/compose.yaml -f deploy/m1/compose.prod.yaml config --format json | node scripts/check-payment-deployment.mjs
```

The checker reports only named pass/fail checks for the shared billing switch, API proxy, private network, and exact payment allow-list rule. It does not contact a provider or validate credentials. Keep the runtime probe, merchant configuration, and real payment acceptance as separate release evidence; a passing configuration check is not payment acceptance. Never save or paste the raw Compose JSON because it contains private environment values.

Payment closing and statement reconciliation require migrations 0140–0143 and the matching API release. `POST /api/v1/credits/recharge-orders/:order_id/close` accepts an empty JSON body from the authenticated original owner. Closing persists an intent first, fences checkout recovery, and queries the original channel after attempting Native close. A payment that already succeeded remains paid; unknown outcomes remain pending for scheduled recovery. The expiry sweep uses the same close path and never issues a refund.

Daily statement downloads are independently disabled by default (`BB_WECHAT_PAY_STATEMENTS_ENABLED=0`). When the merchant's access is ready, enable the flag and set `BB_WECHAT_PAY_STATEMENT_ACCOUNTS=BASIC` or the exact comma-separated subset of `BASIC,OPERATION,FEES` actually used by that merchant. No extra outbound host is needed beyond `api.mch.weixin.qq.com`. The listening API queues the previous seven days after 10:00 Asia/Shanghai, claims two jobs per minute with database leases, and retries unresolved jobs with backoff. Available evidence is rechecked daily within the recent window; each check preserves its own immutable differences. Explicit historical jobs can be queued with the internal `enqueuePaymentStatement` helper within the adapter's 90-day bound; this is an operator action, not a customer URL/upload endpoint.

The API verifies the application response signature, restricts the returned URL to the two documented paths on the exact official host, signs the download, and checks its SHA1 against the authenticated manifest. It requests uncompressed files and limits the complete application/download operation to 30 seconds and 10 MiB. Raw CSV, payment user IDs, product descriptions, merchant remarks and token-bearing download URLs are not retained. Only required financial identifiers, normalized amounts, evidence hashes, checks and differences are stored. `payment_statement_difference` and `payment_statement_unavailable` appear in the existing operations alerts; their details identify the durable statement job/check rather than exposing provider errors.

The modern `ALL` transaction file and funds-account format are supported; unknown legacy headers remain unresolved. Refund rows describe the historical refund application and do not prove today's final refund state. Refund cash and allocation-level credit settlement are audited separately, including quality-correction lots. Merchant funds movements, customer cash and wallet points are not summed as interchangeable amounts. External merchant activity, coupons requiring additional settlement evidence, unmapped fees, and missing evidence remain explicit differences. Statements never create credits, settle refunds, release a hold, or mark a payment paid; corrections require the separately authenticated original-order/query path. Official references and synthetic verification are recorded in `evidence/subscription-billing-20261029/WECHAT-STATEMENT-EVIDENCE.md`.

Reverse payment coverage uses the authenticated provider payment date. Refund API application/success dates are not yet persisted, so first-time refund omissions cannot be assigned to an exact channel day: each trade check records `refund_application_date_uncovered` for a local successful refund with no matching authenticated transaction-bill evidence anywhere in the stored merchant history. This is a merchant-wide coverage exception, not a claim that the refund belongs to that check's bill date; it may recur across daily checks until evidence is obtained. When a matching authenticated historical bill establishes that refund's application day, a later version of the same day's file that omits it records `local_refund_missing_from_statement`. Local `created_at`/`completed_at` never supply the missing channel date. Complete first-time daily reverse refund coverage remains a final acceptance limitation.

### Alipay Web checkout

Alipay uses the pinned official `alipay-sdk` **4.14.0** in direct-merchant RSA2 **public-key mode**. `BB_ALIPAY_PAY_ENABLED=0` is the default. Configure the actual `BB_ALIPAY_APP_ID`, `BB_ALIPAY_SELLER_ID`, protected application private key and Alipay public-key files, exact HTTPS payment callback, and fixed HTTPS return page. `BB_ALIPAY_WEB_PRODUCT` must explicitly be `page` (PC, `alipay.trade.page.pay` / `FAST_INSTANT_TRADE_PAY`) or `wap` (mobile Web, `alipay.trade.wap.pay` / `QUICK_WAP_WAY`). One deployment selects one actually contracted Web product; the API does not infer a signed product from a browser user agent or silently switch to an App payment. Certificate-mode applications, service-provider/ISV grants, cross-border products and mandates require their own adapters and must not be represented by these settings.

When this channel is enabled, append exactly `openapi.alipay.com` to the existing `BB_EGRESS_ALLOW`; preserve the existing model, storage and WeChat entries. SDK signing runs locally; server requests use the existing Node `fetch` environment-proxy policy against the fixed HTTPS gateway, reject redirects, and bound response bodies to 64 KiB. The same 1–30,000 ms configured timeout covers each request and its body (default 10,000 ms). Each signed response is verified with the SDK against its exact original JSON object text, preserving whitespace and escaped Unicode. Duplicate response-envelope fields are rejected. SDK HTTP clients are not used, so they cannot bypass the established egress policy.

The only new inbound form parser is scoped to the existing payment-callback plugin. `POST /api/v1/payments/alipay/callback` accepts UTF-8 `application/x-www-form-urlencoded` with strict one-time decoding and rejects duplicate names, including alternate percent-encoded spellings. SDK verification must pass before checking app ID, seller ID, original trade, amount and currency. It returns plain text `success` only after the existing payment/credit transaction commits; a browser return URL is never a payment fact. Other write endpoints keep their session/CSRF rules and JSON schema. A signed `TRADE_CLOSED` query can also describe an old fully refunded payment, so status alone cannot make a payment unpaid; ambiguous results stay unresolved. `send_pay_date` is seller-transfer time and is not stored as customer payment time. A signed callback's `gmt_payment` is eligible evidence.

`BB_ALIPAY_REFUND_ENABLED=0` is a separate default. Before enabling it, verify that this merchant returns independent original `buyer_pay_amount` and per-request `present_refund_buyer_amount` in authenticated results. Missing or discounted original buyer cash prevents dispatch. Missing per-refund buyer cash keeps an already dispatched refund frozen for reconciliation. `alipay.trade.refund` uses the original `out_request_no` for every recovery; its `refund_fee` is cumulative, so the adapter always verifies the specific request through `alipay.trade.fastpay.refund.query` and `REFUND_SUCCESS`. Merchant `send_back_fee` is not substituted for buyer cash. The normal direct-merchant API identifies refunds by the authenticated `(trade_no, out_request_no)` pair. Its JSON array is hashed with SHA256 and prefixed `alipay_` as the stable local provider-refund reference; this is a normalized reference, not an invented standalone Alipay transaction number. Refund completion is polled; cumulative trade notifications cannot settle a particular refund. A missing refund status or unsuccessful query is not proof of final failure.

Both Web products buy a single subscription period or top-up; neither authorizes recurring deductions. Alipay daily statement downloading is not implemented by this adapter. Merchant product entitlement, app-to-seller identity mapping, real callback/query/close/refund behavior, negotiated buyer-refund fields, and the exact release image/proxy still need final merchant acceptance before the defaults are enabled. Local evidence is in `evidence/subscription-billing-20261029/ALIPAY-WEB-EVIDENCE.md`.

### Worker runtime and shutdown (#17)

`deploy/m1/Dockerfile` starts `node apps/worker/dist/runtime.js` directly as PID 1. Compose enables durable run submission on the API with `BB_RUN_RUNTIME_ENABLED=1`; the worker starts after migrations, alternates leased `run` and `parse` claims, and writes the heartbeat consumed by `/api/v1/ready`. Production profile defaults to one worker slot to fit the 320 MiB memory limit. The separate `ops` service keeps its explicit `node apps/worker/dist/ops-scheduler.js` command.

The operator model probe remains disabled unless `BB_PLATFORM_PROBE_ENABLED=1`. On SIGTERM/SIGINT the runtime stops new claims, drains for `BB_WORKER_DRAIN_MS` (20 seconds by default), aborts run work if the drain expires, releases active run/parse leases, records a stopped heartbeat, then exits. `worker.stop_grace_period` is 30 seconds so Compose does not cut off the drain. Jobs resume from PostgreSQL checkpoints after recovery. Missing production rule pins/selectors and other owner capabilities remain fail-closed as `capability_not_ready`; this runtime wiring does not mean a run can produce or deliver a Word result.

Staging limits are ceilings (postgres 768M, worker 768M, api 512M, azurite 256M, migrate 256M, web 128M, egress 96M). `compose.prod.yaml` is the small-host production profile (below): `postgres:16-alpine` with small buffers, capped Node heaps, no Azurite, and Blob traffic through the egress proxy.

## Preproduction working draft window

Leave `BB_DEPLOYMENT_TIER=production`, `BB_NON_PRODUCTION_TEST_CHANNEL=disabled`, and all five
`BB_PREPROD_WORKING_DRAFT_*` values empty in the checked-in example and production configuration.
For a controlled preproduction window, set `BB_DEPLOYMENT_TIER=preprod` and
`BB_NON_PRODUCTION_TEST_CHANNEL=enabled` in the private deployment `.env`, then set **all five**:

| Variable | Required value |
|---|---|
| `BB_PREPROD_WORKING_DRAFT_EXPIRES_AT` | Future ISO timestamp no more than seven days away |
| `BB_PREPROD_WORKING_DRAFT_TAXONOMY_HASH` | Exact 64-character lowercase SHA-256 of the candidate taxonomy |
| `BB_PREPROD_WORKING_DRAFT_RULE_PACK_HASH` | Exact 64-character lowercase SHA-256 of the candidate rule pack |
| `BB_PREPROD_WORKING_DRAFT_STAGE` | `registration` or `issuance` |
| `BB_PREPROD_WORKING_DRAFT_AS_OF` | Real rule evaluation date, `YYYY-MM-DD` |

These values reach only the `api` service; the background service already receives the existing
test-channel switch. The API checks the authenticated owner, locked materials and parse results
before granting a working draft. A partially filled or invalid window rejects preflight and
ordinary update submission; five empty or whitespace-only values preserve the normal route.
Check the resolved API environment with `docker compose config` before applying the private
configuration. Do not include private `.env` contents in release evidence.

To roll back automatic admission, clear all five values in the private `.env` and recreate the
API service with the usual deployment procedure. Disable `BB_NON_PRODUCTION_TEST_CHANNEL` as
well if test artifacts must become unreadable and active test runs must pause; this switch also
affects existing grants. Verify the resolved API environment, then retry an ordinary update and
confirm it follows the normal production channel. Existing test runs do not convert channels.

## Target host requirements (measured in staging, 2026-09-25)

Measured on the worker host with the release images and the full browser acceptance suite (synthetic, small files):

| | staging profile (`compose.yaml`) | production profile (`+ compose.prod.yaml`) |
|---|---|---|
| memory limits (steady state) | 2.5 GB incl. Azurite | **1168 MiB** (postgres 256, worker 320, api 512, egress 48, web 32); migrate 128 MiB runs first |
| measured peak per container | postgres 114, api 65, azurite 61, worker 48, egress 17, web 13 MiB | api 136, postgres 104, worker 43, egress 13, web 10 MiB (Azurite 54 MiB was only the test stand-in) |
| measured peak sum | ≈ 320 MiB | **≈ 306 MiB**; no OOM kill, no restart |

Upload capacity (#6/#35): request bodies stream to the disk-backed `uploadspool` volume (never the tmpfs `/tmp`), hashed on the way; Blob writes are staged in 4 MiB blocks. Inspection is single-flight per api process; waiting requests get a retryable `503 DATA_UNAVAILABLE` after 60 s (`BB_UPLOAD_INSPECTION_QUEUE_MS`). Measured on the prod profile: a ~96 MiB scanned-style PDF peaks at ~470 MiB container memory (353 MiB anon), which is why the api limit is 512M. DOCX/XLSX are still read whole inside the parser worker (open risk, see PR).

The api peak comes from Argon2id (19 MiB per hash); 192 MiB leaves room for a few concurrent logins. The worker peak was measured on small synthetic DOCX only. A 100 MB PDF or an OCR-heavy file has not been measured and may exceed 320 MiB; the job then fails or retries through its lease, and the worker restarts. Raise the limit if real material needs it.

**Minimum RAM:** 1 GB free for the production profile (the limits add up to 848 MiB; measured use ≈ 310 MiB). The staging profile needs 3 GB.

**Disk (measured image sizes, uncompressed):** api 539 MB and worker 863 MB, sharing the `node:22-bookworm-slim` base (≈ 200 MB) and app layers. The unique worker delta is ≈ 325 MB (Python 3.11 venv 177 MB plus apt python). web 82 MB, egress 30 MB, `postgres:16-alpine` 420 MB (`postgres:16` is 642 MB). The four release images are **235 MB** as a gzip `docker save`.

- **Deploying from exported images** (recommended for small hosts): ≈ 1.2 GB for a first install when the node base is already present, plus ≈ 0.4 GB per extra retained release. Add the 235 MB tarball while loading, plus data. **Minimum free disk: 2.5 GB**; keep ≥ 1 GB free afterwards for PostgreSQL growth.
- **Building on the target** (`deploy.sh` without preloaded images) additionally needs the build stage (848 MB) plus npm/BuildKit cache, about 1.5–2 GB transient. **Minimum free disk: 4 GB**; run `docker builder prune` afterwards.
- A general-purpose host running the staging profile should have ≥ 15 GB free.

**Ports:** the stack binds only `127.0.0.1:${BB_HTTP_PORT}`. Host nginx terminates TLS on 443 (and 80 for ACME/redirect). Outbound 443 goes to the model provider and Blob through the egress proxy. Builds also need the Docker registry and GitHub.

**Network:** `backend` uses `BB_BACKEND_SUBNET` (default `10.231.0.0/24`) and `BB_WEB_IP`. Pick a /24 that no other Docker network on the host uses (`docker network inspect $(docker network ls -q) | grep Subnet`).

### Small shared host: openclaw-vm

At 2026-09-25 13:20 UTC, openclaw-vm had a 30 GB Premium_LRS OS disk with **2.6 GB free (91% used)**, 2 vCPU and 3.3 GB RAM. BondDraftAI and motive share this host. This is below the 4 GB free-disk minimum above for building on the target. A 30 GB OS-disk snapshot, `openclaw-vm-osdisk-pre64g-20260925`, exists. Azure rejected online resizing while the VM was running; expansion to 64 GB requires deallocate, resize and restart from an off-host Azure control plane, followed by partition/filesystem expansion. The public IP `20.243.2.34` is Static/Standard. See [#35 capacity evidence](https://github.com/ITSophiaXu/BondBuddy/issues/35#issuecomment-5833070385). Do not treat the current disk as production-ready.

1. `.env`: `BB_PROFILE=prod`, `COMPOSE_PROFILES=` (empty, so no Azurite), `BB_BIND_ADDR=127.0.0.1`, `BB_HTTP_PORT=18090` (free on that host), a free `BB_BACKEND_SUBNET`/`BB_WEB_IP`, `AZURE_STORAGE_CONNECTION_STRING=<private Azure Blob>`, `BB_EGRESS_ALLOW=api.deepseek.com,<account>.blob.core.windows.net`. The api and worker reach Blob only through the proxy.
2. The current pre-production repo reaches this host as a git bundle over its existing SSH route; `deploy.sh <develop-sha>` builds on the target unless release images are preloaded. The repository deploy-key route is unavailable. Before each build, check `df -h /`, remove only obsolete BondBuddy images, and prune BuildKit afterwards. The private deployment key stays on the deployment controller.
3. The active M1 pre-production origin is `https://bondbuddy.gululai.com`, served through Aliyun ESA (edge TLS and verified HTTPS origin) to a dedicated host nginx virtual host. `BB_PUBLIC_ORIGIN` has that exact value. Nginx also redirects the old `bonddraft.gululai.com` M1 paths to the new host while its legacy Cowork paths remain on BondDraftAI. Run `nginx -t` successfully before any nginx reload. The certbot template below is an alternative for a future direct TLS deployment, not this active ESA setup. See [#35 domain evidence](https://github.com/ITSophiaXu/BondBuddy/issues/35#issuecomment-5832747527).
4. The earlier backup/restore drill passed on release `3506c9a40983` ([evidence](https://github.com/ITSophiaXu/BondBuddy/issues/35#issuecomment-5831777066)). The daily host backup cron was disabled on 2026-09-29. `backup.sh` and `restore.sh` remain as legacy manual tools, but are not part of routine releases or scheduled operations.

## First install

```sh
cd <repo>/deploy/m1
cp .env.example .env && chmod 600 .env    # fill in on the host; never commit
# COMPOSE_PROJECT_NAME=bb-m1-prod, POSTGRES_PASSWORD=$(openssl rand -hex 24),
# AZURE_STORAGE_CONNECTION_STRING=<private Blob>, BB_PUBLIC_ORIGIN=https://<host>,
# BB_TERMS_VERSION=<current terms>, BB_HTTP_PORT=18080, BB_EGRESS_ALLOW=...
git fetch origin && ./scripts/deploy.sh origin/master   # only where the target has a trusted repo fetch route
```

Production must use a reviewed `develop` → `master` PR and the resulting exact `master` commit. On openclaw-vm there is no repository deploy key: master sends that commit through a verified git bundle over its existing SSH route, and the target deploys the bundled commit. Do not substitute a local `develop` checkout for a production release.

The DeepSeek rollback configuration uses `BB_CODEX_CREDENTIAL_ENV` (default `DEEPSEEK_API_KEY`); `auth.json` is not used. The explicit Copilot Enterprise switch and its read-only OAuth file mount are documented in [copilot-model-provider.md](copilot-model-provider.md). Leave model credentials unavailable to keep model calls disabled.

## Deploy

`scripts/deploy.sh <git-sha>`:

1. `git archive <sha>` into a temp dir and builds `api`, `worker`, `web` and `egress` images tagged with the first 12 characters of the sha (no uncommitted files can enter an image).
2. When `BB_DEPLOY_INFLIGHT_GATE=1`, check for active non-parse runs again after image build. No backup is created. Before release, confirm that any schema change is compatible with the retained rollback image; an image rollback cannot reverse data or migrations.
3. Starts postgres (and Azurite in staging), runs `migrate`, then `up --wait` for api/worker/egress/web.
4. Records the tag in `state/current` (the old one in `state/previous`), appends `state/releases.log`, and runs `smoke.sh` against the local port.

`scripts/smoke.sh <base-url>` checks `/healthz`, the SPA, security headers (nosniff, CSP, no server version), `401` on anonymous `/api/v1/me`, and greps the served JS for key-like strings. Run it again against the public HTTPS URL after the deploy.

## Rollback

`scripts/rollback.sh <previous-sha>` re-points the services at images that already exist for that sha and smokes. It does **not** run or undo migrations or restore data. Migrations are append-only; verify that the retained image can read the new schema before release. With routine backups disabled, rollback cannot recover deleted or corrupted data.

## Legacy manual backup and restore tools

- `scripts/backup.sh [label]` writes `backups/<utc>-<label>/` (mode 700): `db.dump` (`pg_dump -Fc`), `blobs/` (only the configured application containers, plus `manifest.json` with sha256 and content type, exported by `scripts/blob-snapshot.mjs` inside the api image) and `manifest.txt` (release, dump sha256). `BB_BLOB_BACKUP_CONTAINERS` is an optional comma-separated list; when empty, the export selects `bondbuddy-private` plus `BB_LOG_ARCHIVE_CONTAINER` and `BB_LIBRARY_CONTAINER`, without duplicates. The `BB_BACKUP_CONTAINER` off-host container is always excluded. A configured container that does not exist fails the backup before a manifest is written, so an incorrect scope cannot appear successful. Set the list explicitly if any application data is stored outside those defaults. Download, hash verification and upload use bounded streams for large files. For production Blob, also enable soft delete and versioning on the storage account.
- **Off-host copy (#35).** If explicitly invoked, `backup.sh` runs `scripts/backup-offhost.mjs upload` inside the api image with the existing `AZURE_STORAGE_CONNECTION_STRING`. In production the api container reaches Blob only through `HTTPS_PROXY=http://egress:3128`, so `BB_EGRESS_ALLOW` must list the Blob host. Every file becomes `bb-backups/<backup-id>/<path>`, where `<backup-id>` is the directory name (`<utc>-<label>`). The container is created private, with no anonymous access. Each blob is downloaded again and its sha256 compared. Only after every file verifies is `<backup-id>/offhost-manifest.json` written; that manifest marks the backup complete. `manifest.txt` then gets `offhost=blob:<backup-id>`, and every older local backup directory is deleted, so only the newest stays on disk. If the upload fails, `backup.sh` exits non-zero and deletes nothing. `deploy.sh` does not call this tool. `BB_BACKUP_OFFHOST=off` keeps everything local (dev stacks only).
- **Schedule.** The former daily host cron entry was removed on 2026-09-29. No replacement backup schedule is enabled. There is no `BB_OPS_BACKUP` switch.
- **Retention.** The ops scheduler's `backup_retention` task (every 6 h, `BB_OPS_BACKUP_RETENTION_SECONDS`) deletes off-host backups whose id time is older than `BB_BACKUP_RETENTION_DAYS` (default 30, the published policy). The newest off-host backup is always kept. Names that are not `<utc>-<label>/...` are left alone. The task is idempotent: a partial failure is finished by the next run. A failure raises a `scheduled_task_failed` alert (scope `backup_retention`), and `bb_ops_schedule.last_succeeded_at` (migration 0031) records the last success: `SELECT last_status,last_succeeded_at FROM bb_ops_schedule WHERE task='backup_retention'`. `BB_OPS_BACKUP_RETENTION=off` disables it. The task runs only when `AZURE_STORAGE_CONNECTION_STRING` is set.
- `scripts/restore.sh <backup-dir>` or `scripts/restore.sh blob:<backup-id>` stops web/worker/api, recreates the database from `db.dump`, re-imports every blob with a sha256 check, and starts the stack. With `blob:`, the backup is first downloaded to `backups/restore-<backup-id>/`. The download refuses a backup that has no `offhost-manifest.json` (an incomplete upload) and checks every file's sha256. In both modes `db.dump` is checked against `manifest.txt` before anything is stopped. Blobs created after the backup are not deleted; the storage lifecycle orphan cleaner handles them. List off-host backups with `az storage blob list -c bb-backups --delimiter / ...` or the portal.
- **Historical drill:** a backup was made, a material was deleted, then restored and checked by re-login, material hash and locked input hash. `deploy/m1/acceptance/staging.spec.ts` contains the drill; its historical record is in `deploy/m1/evidence/`. It is not part of the current release procedure.

## TLS

The web container speaks plain HTTP on loopback only. TLS terminates in front of it:

- **Active openclaw-vm pre-production:** ESA terminates public TLS for `bondbuddy.gululai.com` and verifies the HTTPS Azure origin certificate. Host nginx routes that hostname to loopback `127.0.0.1:${BB_HTTP_PORT}`. The public hostname's CNAME must be the exact ESA-assigned value, not a modified copy of another hostname's record. Verify public TLS, origin routing and security headers after changes; keep `BB_PUBLIC_ORIGIN=https://bondbuddy.gululai.com`.
- **Future direct TLS deployment:** the nginx template `deploy/m1/nginx/host-server-block.conf.example` can use its own public certificate (for example Let's Encrypt), `listen 443 ssl http2`, `proxy_pass http://127.0.0.1:${BB_HTTP_PORT}`, `proxy_set_header X-Forwarded-Proto https`, HTTP→HTTPS redirect on 80, and `client_max_body_size 101m`. `BB_PUBLIC_ORIGIN` must equal the exact HTTPS origin because the API enforces Origin/CSRF and sets `Secure` cookies.
- **Disposable worker-host staging:** a cloudflared quick tunnel can give a temporary `https://*.trycloudflare.com` origin. It is not the active pre-production or production hostname.

## Operator grants (#79)

Admin log routes return 404 unless the user has an active grant. Grant from a maintenance session only: `scripts/grant-operator.sh <username> log_reader|log_operator|prompt_viewer <reason_code>`; revoke by setting `revoked_at` on the grant row. See `docs/runbooks/log-alert-recovery.md` for forwarding and alerts.

## Ops scheduler (#79, #35)

The `ops` service (worker image, `node apps/worker/dist/ops-scheduler.js`, 64M limit, `--max-old-space-size=40`) replaces the host-cron one-shots. It ticks every `BB_OPS_TICK_SECONDS` (5 s, ±20 % jitter) and runs each task only after winning the lease row for that task in `bb_ops_schedule` (migration 0028): the task must be due and not leased. Two scheduler instances (for example a stray `compose run ops`) therefore never run the same due run twice; a crashed holder's lease expires and the next instance picks the task up. The next due time is the interval ±10 % jitter. Tasks run one at a time inside a process.

| task | default interval (env, seconds) | what it runs | enabled when |
|---|---|---|---|
| `log_forward` | 30 (`BB_OPS_LOG_FORWARD_SECONDS`) | `forwardLogs` to NDJSON, up to 10×100 events per run | `BB_LOG_SINK_FILE` set (compose default `/var/lib/bb-logs/observability.ndjson`) |
| `log_health` | 60 (`BB_OPS_LOG_HEALTH_SECONDS`) | `checkLogHealth` (backlog > `BB_LOG_BACKLOG_ALERT_SECONDS`, usage conflicts) | always |
| `storage_purge` | 900 (`BB_OPS_STORAGE_PURGE_SECONDS`) | `runUserDeletionLifecycle`: orphan uploads, deleted material/project bytes, derived content, log content retention, using the published values above | `BB_STORAGE_PURGE_ENABLED=true` |
| `trial_health` | 300 (`BB_OPS_TRIAL_HEALTH_SECONDS`) | `checkTrialHealth` (queue backlog, error rate, global quota, heartbeat) | always |
| `worker_heartbeat` | 60 (`BB_OPS_WORKER_HEARTBEAT_SECONDS`) | raises `worker_heartbeat_stale` when no live worker heartbeat is newer than `BB_READY_WORKER_HEARTBEAT_MAX_AGE_SECONDS` (90) | always |
| `parse_backfill` | 3600 (`BB_OPS_PARSE_BACKFILL_SECONDS`) | `backfillParseJobs` | `BB_OPS_PARSE_BACKFILL=on` |

Any task can be switched off with `BB_OPS_<TASK>=off` (for example `BB_OPS_STORAGE_PURGE=off`). Every task is idempotent on its own, so a rerun after a lost lease is safe.

**Failures.** A run that throws or reports failed items records `last_status='failed'` and `last_error_code` in `bb_ops_schedule` and appends a `scheduled_task_failed` (critical) row to `bb_ops_alerts`, deduplicated per task per hour. `GET /api/v1/admin/alerts` shows it. The task is retried at its next interval. The underlying tasks still raise their own alerts (`log_sink_unavailable`, `log_backlog_stale`, `worker_heartbeat_stale`, ...), see `log-alert-recovery.md` and `m1-trial-operations.md`.

**Log sink (staging).** NDJSON lines go to the `logsink` named volume at `/var/lib/bb-logs/observability.ndjson`, mode 0600. The scheduler no longer rotates it: an expired forwarder can send an old key after a receipt and finite segment replacement, so receipt-only rotation cannot guarantee unique output. Existing keys in the active file or legacy `.1` can replay; batches needing new bytes fail closed if they would exceed `BB_LOG_SINK_MAX_BYTES` (default 64 MiB), leaving their PostgreSQL outbox rows pending and raising a sink alert. A legacy file already over cap can replay existing keys. Do not force rotation; a separately reviewed durable key journal or PostgreSQL-backed sink is needed for continued bounded forwarding. Stop the old scheduler before deploying this change.

**Checks.**

```sh
compose logs --tail 20 ops                   # one JSON line per task run
compose exec postgres psql -U bondbuddy -d bondbuddy -c \
  "SELECT task,last_status,last_error_code,last_finished_at,next_due_at,runs,failures FROM bb_ops_schedule ORDER BY task"
```

To run one task now, set its `next_due_at` to `now()`; the scheduler picks it up within one tick. On rollback to an image without the scheduler, `rollback.sh` does not touch `ops`, which keeps running the newer image against the same schema. Stop it with `compose stop ops` if needed.

## Known gaps

- The ops scheduler forwards logs to a local NDJSON file only (staging sink). A remote log store for production is not chosen yet; point `BB_LOG_SINK_FILE` at a shipped volume or add a sink when it is.
- The parse backfill is wired but off by default (`BB_OPS_PARSE_BACKFILL=on` enables it hourly).
- In openclaw-vm pre-production release `3506c9a40983`, the worker still starts the one-shot parse loop instead of the merged leased run runtime. Public `/api/v1/ready` returned 503 with `worker_heartbeat=missing` on 2026-09-25. Deploy and verify the #17 entrypoint repair before treating run execution as ready.
- The current pre-production stack uses private Azure Blob, and its backup-to-Blob/restore drill passed (see evidence above). That does not establish a production release from `master` or prove recovery after loss of the storage account.
- The model router retains the historical update stage and parks generation without trusted #33 adapters. Production rule-pack selection and Word delivery remain prerequisites. Missing capabilities pause at `capability_not_ready`; this deployment slice has no live model or Word acceptance.
- Off-host backups use the same storage account as the application blobs. Losing that account loses both; a second account or region is not configured.

## Trial guard and data-lifecycle environment (2026-09-25)

`compose.yaml` passes the trial-guard (#35) and data-lifecycle (#6/#79) settings to `api` and `worker` through the `x-bb-policy-env` anchor. `BB_TRIAL_SOURCE_SALT` is required: generate it on the target host (`openssl rand -hex 24`) and keep it there. The **published M1 trial policy** (CTO decision, 2026-09-25, under the owner's delegation) is the default:

| setting | value |
|---|---|
| deleted material / project bytes purged after | 7 days (`BB_STORAGE_MATERIAL_RETENTION_DAYS`) |
| orphan upload grace | 24 hours (`BB_STORAGE_ORPHAN_GRACE_HOURS`) |
| prompt / log content retention | 180 days (`BB_LOG_CONTENT_RETENTION_DAYS`) |
| backup retention | 30 days (`BB_BACKUP_RETENTION_DAYS`) |

The web data-policy copy renders these values from the API, so changing them in `.env` changes both behaviour and copy.
