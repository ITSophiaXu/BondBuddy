# M1 deployment runbook (#35)

Everything lives in `deploy/m1/`. This runbook covers target-host requirements, first install, deploy, rollback, backup/restore drill and TLS. It does not replace the release record: every production deploy, rollback and restore is logged in `deploy/m1/state/releases.log` on the host, and must also be noted on the release Issue/PR with the commit, migrations, verification and rollback plan.

## Stack

| service | image | notes |
|---|---|---|
| `postgres` | `postgres:16` | named volume `pgdata`; only on the internal `backend` network |
| `azurite` | Azurite 3.35 | **staging only** (`COMPOSE_PROFILES=staging-blob`). Production omits it and sets `AZURE_STORAGE_CONNECTION_STRING` to the private Azure Blob account. |
| `migrate` | `bondbuddy-m1-api:<sha>` | one-shot `node db/migrate.mjs`; `api` and `worker` start only after it exits 0 |
| `api` | `bondbuddy-m1-api:<sha>` | Fastify on :3000, non-root, read-only rootfs, trusts forwarded headers only from the nginx container address |
| `worker` | `bondbuddy-m1-worker:<sha>` | Node 22 + Python 3.11 venv; drains durable material parse jobs. No model-backed run processor is installed yet, so runs stay not-ready (`CAPABILITY_NOT_READY`) rather than faked. |
| `egress` | `bondbuddy-m1-egress:<sha>` | squid allow-list forward proxy, the **only** route out of `backend` |
| `web` | `bondbuddy-m1-web:<sha>` | unprivileged nginx on :8080: static web build at `/`, `/api/v1/` → api, `/healthz` → api `/health` |

`backend` is a Docker `internal` network (no gateway). The worker gets `HTTPS_PROXY=http://egress:3128`; squid only accepts `CONNECT host:443` for names in `BB_EGRESS_ALLOW` (default `api.deepseek.com`). In production add the Blob host, for example `BB_EGRESS_ALLOW=api.deepseek.com,<account>.blob.core.windows.net`. `scripts/egress-test.sh` proves the policy from inside the worker container: direct TCP fails, non-listed hosts get 403, the provider host gets a tunnel (closed at once; no TLS or model request is sent).

Staging limits are ceilings (postgres 768M, worker 768M, api 512M, azurite 256M, migrate 256M, web 128M, egress 96M). `compose.prod.yaml` is the small-host production profile (below): `postgres:16-alpine` with small buffers, capped Node heaps, no Azurite, and Blob traffic through the egress proxy.

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

- **Deploying from exported images** (recommended for small hosts): ≈ 1.2 GB for a first install when the node base is already present, plus ≈ 0.4 GB per extra retained release. Add the 235 MB tarball while loading, plus data and backups. **Minimum free disk: 2.5 GB**; keep ≥ 1 GB free afterwards for PostgreSQL growth and backups.
- **Building on the target** (`deploy.sh` without preloaded images) additionally needs the build stage (848 MB) plus npm/BuildKit cache, about 1.5–2 GB transient. **Minimum free disk: 4 GB**; run `docker builder prune` afterwards.
- A general-purpose host running the staging profile should have ≥ 15 GB free.

**Ports:** the stack binds only `127.0.0.1:${BB_HTTP_PORT}`. Host nginx terminates TLS on 443 (and 80 for ACME/redirect). Outbound 443 goes to the model provider and Blob through the egress proxy. Builds also need the Docker registry and GitHub.

**Network:** `backend` uses `BB_BACKEND_SUBNET` (default `10.231.0.0/24`) and `BB_WEB_IP`. Pick a /24 that no other Docker network on the host uses (`docker network inspect $(docker network ls -q) | grep Subnet`).

### Small shared host: openclaw-vm

As of 2026-09-25, openclaw-vm has one 5.3 GB-free root disk, 2 vCPU and 3.3 GB RAM, with about 1.3 GB left after BondDraftAI/motive. Ports 80, 443, 3001, 5174, 8088, 8501, 8503, 8506 and 9506 are taken, and host nginx serves `bonddraftai-openclaw.japaneast.cloudapp.azure.com`.

1. `.env`: `BB_PROFILE=prod`, `COMPOSE_PROFILES=` (empty, so no Azurite), `BB_BIND_ADDR=127.0.0.1`, `BB_HTTP_PORT=18090` (free on that host), a free `BB_BACKEND_SUBNET`/`BB_WEB_IP`, `AZURE_STORAGE_CONNECTION_STRING=<private Azure Blob>`, `BB_EGRESS_ALLOW=api.deepseek.com,<account>.blob.core.windows.net`. The api and worker reach Blob only through the proxy.
2. Build on the worker host: `scripts/export-images.sh <sha> m1-<sha>.tar.gz`. Copy the tarball over the authorised SSH route, `docker load -i` it, delete it, then `scripts/deploy.sh <sha>`; the preloaded images are reused. Expect ≈ 1.2 GB of new images. Check `df -h /` stays ≥ 1 GB free.
3. Host nginx: install `deploy/m1/nginx/host-server-block.conf.example` as a **separate server block with its own hostname** and certificate (`certbot --nginx -d <host>`). The app cannot be mounted under a path of the BondDraftAI hostname: it uses root paths (`/assets`, `/api/v1`) and `Path=/` cookies. It therefore needs its own DNS name, for example a second Azure DNS label or CNAME. Choosing that name is a CTO decision. `BB_PUBLIC_ORIGIN` must equal `https://<that host>`.
4. Backups share the only disk: run `backup.sh`, copy the directory off-host, then delete the local copy.

## First install

```sh
cd <repo>/deploy/m1
cp .env.example .env && chmod 600 .env    # fill in on the host; never commit
# COMPOSE_PROJECT_NAME=bb-m1-prod, POSTGRES_PASSWORD=$(openssl rand -hex 24),
# AZURE_STORAGE_CONNECTION_STRING=<private Blob>, BB_PUBLIC_ORIGIN=https://<host>,
# BB_TERMS_VERSION=<current terms>, BB_HTTP_PORT=18080, BB_EGRESS_ALLOW=...
git fetch origin && ./scripts/deploy.sh origin/master   # production deploys from master only
```

The model credential is passed only through the adapter's env credential mode: `BB_CODEX_CREDENTIAL_ENV` names the variable (default `DEEPSEEK_API_KEY`) and its value lives in `.env` or a host-mounted env file. `auth.json` credential files are not used. Leave the key empty to keep model calls disabled.

## Deploy

`scripts/deploy.sh <git-sha>`:

1. `git archive <sha>` into a temp dir and builds `api`, `worker`, `web` and `egress` images tagged with the first 12 characters of the sha (no uncommitted files can enter an image).
2. If a release is running, `backup.sh pre-deploy-<tag>` runs first.
3. Starts postgres (and Azurite in staging), runs `migrate`, then `up --wait` for api/worker/egress/web.
4. Records the tag in `state/current` (the old one in `state/previous`), appends `state/releases.log`, and runs `smoke.sh` against the local port.

`scripts/smoke.sh <base-url>` checks `/healthz`, the SPA, security headers (nosniff, CSP, no server version), `401` on anonymous `/api/v1/me`, and greps the served JS for key-like strings. Run it again against the public HTTPS URL after the deploy.

## Rollback

`scripts/rollback.sh <previous-sha>` re-points the services at images that already exist for that sha and smokes. It does **not** run or undo migrations. Migrations are append-only, so older code usually tolerates the newer schema. When the release notes say it does not, restore the `pre-deploy-<tag>` backup (below) after rolling back; data written since the deploy is then lost and must be recorded in the incident.

## Backup and restore

- `scripts/backup.sh [label]` writes `backups/<utc>-<label>/` (mode 700): `db.dump` (`pg_dump -Fc`), `blobs/` (every blob of every container plus `manifest.json` with sha256 and content type, exported by `scripts/blob-snapshot.mjs` inside the api image) and `manifest.txt` (release, dump sha256). Copy it off-host. For production Blob, also enable soft delete and versioning on the storage account.
- `scripts/restore.sh <backup-dir>` stops web/worker/api, recreates the database from `db.dump`, re-imports every blob with a sha256 check, and starts the stack. Blobs created after the backup are not deleted; the storage lifecycle orphan cleaner handles them.
- **Drill:** backup, then make a user-visible change (delete a material), restore, re-login, and confirm the material, its bytes (the download route re-verifies the sha256) and the locked input snapshot hash are back. `deploy/m1/acceptance/staging.spec.ts` automates this; the staging record is in `deploy/m1/evidence/`.

## TLS

The web container speaks plain HTTP on loopback only. TLS terminates in front of it:

- **Production:** host nginx (template: `deploy/m1/nginx/host-server-block.conf.example`) with a public certificate (Let's Encrypt via certbot), `listen 443 ssl http2`, `proxy_pass http://127.0.0.1:${BB_HTTP_PORT}`, `proxy_set_header X-Forwarded-Proto https`, HTTP→HTTPS redirect on 80, and `client_max_body_size 101m`. `BB_PUBLIC_ORIGIN` must equal the exact `https://` origin because the API enforces Origin/CSRF and always sets `Secure` cookies.
- **Staging (worker host):** a cloudflared quick tunnel `cloudflared tunnel --url http://127.0.0.1:${BB_HTTP_PORT}` gives a `https://*.trycloudflare.com` origin. The URL changes when cloudflared restarts; update `BB_PUBLIC_ORIGIN` and `docker compose up -d api` afterwards. Quick tunnels have no uptime guarantee and all traffic reaches nginx from one address, so per-source login limits see every client as one source.

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

**Log sink (staging).** NDJSON lines go to the `logsink` named volume at `/var/lib/bb-logs/observability.ndjson`, mode 0600. Before each batch, a file over `BB_LOG_SINK_MAX_BYTES` (64 MiB) is renamed to `.1`, replacing the previous `.1`, so the volume holds at most about 128 MiB. PostgreSQL (`bb_observability_events`, `bb_log_deliveries`) stays the record; the file is a forwarded copy and consumers dedupe on `delivery_key`.

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
- No model-backed run processor or Codex CLI is installed in the worker image; production execute stays not-ready until #17 wires it.
- Staging uses Azurite; a production Blob backup/restore has not been exercised.

## Trial guard and data-lifecycle environment (2026-09-25)

`compose.yaml` passes the trial-guard (#35) and data-lifecycle (#6/#79) settings to `api` and `worker` through the `x-bb-policy-env` anchor. `BB_TRIAL_SOURCE_SALT` is required: generate it on the target host (`openssl rand -hex 24`) and keep it there. The **published M1 trial policy** (CTO decision, 2026-09-25, under the owner's delegation) is the default:

| setting | value |
|---|---|
| deleted material / project bytes purged after | 7 days (`BB_STORAGE_MATERIAL_RETENTION_DAYS`) |
| orphan upload grace | 24 hours (`BB_STORAGE_ORPHAN_GRACE_HOURS`) |
| prompt / log content retention | 180 days (`BB_LOG_CONTENT_RETENTION_DAYS`) |
| backup retention | 30 days (`BB_BACKUP_RETENTION_DAYS`) |

The web data-policy copy renders these values from the API, so changing them in `.env` changes both behaviour and copy.
