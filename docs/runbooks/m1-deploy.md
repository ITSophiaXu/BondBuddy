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

Resource limits (sum ≈ 2.7 GB, 5.75 CPU shares) fit a 2 vCPU / 3 GB VM because the limits are ceilings, not reservations: postgres 768M, worker 768M, api 512M, azurite 256M (staging), migrate 256M, web 128M, egress 96M.

## Target host requirements

- Ubuntu 22.04+ (or any Linux with Docker Engine 24+ and Compose v2.20+), git, curl, openssl.
- **Disk: ≥ 15 GB free** on the Docker data root: images ≈ 1.6 GB per release (keep the previous release for rollback), build cache ≈ 2 GB, PostgreSQL and Blob data, and local backups. Put backups on a separate disk or copy them off-host.
- **RAM: ≥ 3 GB** (2 GB is not enough while a release builds). vCPU: 2.
- **Ports:** 22 (SSH, restricted), 443 (and 80 for ACME/redirect) on the host TLS terminator. The stack itself binds only `127.0.0.1:${BB_HTTP_PORT}`; nothing else is published. Outbound: 443 to the model provider and Blob via the egress proxy, plus the Docker registry and GitHub during builds.
- The deploy user is in the `docker` group and has a clone of the repository.

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

- **Production:** host nginx (or Caddy) with a public certificate (Let's Encrypt via certbot), `listen 443 ssl http2`, `proxy_pass http://127.0.0.1:${BB_HTTP_PORT}`, `proxy_set_header X-Forwarded-Proto https`, HTTP→HTTPS redirect on 80, and `client_max_body_size 101m`. `BB_PUBLIC_ORIGIN` must equal the exact `https://` origin because the API enforces Origin/CSRF and always sets `Secure` cookies.
- **Staging (worker host):** a cloudflared quick tunnel `cloudflared tunnel --url http://127.0.0.1:${BB_HTTP_PORT}` gives a `https://*.trycloudflare.com` origin. The URL changes when cloudflared restarts; update `BB_PUBLIC_ORIGIN` and `docker compose up -d api` afterwards. Quick tunnels have no uptime guarantee and all traffic reaches nginx from one address, so per-source login limits see every client as one source.

## Operator grants (#79)

Admin log routes return 404 unless the user has an active grant. Grant from a maintenance session only: `scripts/grant-operator.sh <username> log_reader|log_operator|prompt_viewer <reason_code>`; revoke by setting `revoked_at` on the grant row. See `docs/runbooks/log-alert-recovery.md` for forwarding and alerts.

## Known gaps

- Log forwarding (`log-ops` forward/health) and storage purge are not scheduled by this Compose file yet; run them from cron on the host or add services once their sinks and retention values are decided.
- No model-backed run processor or Codex CLI is installed in the worker image; production execute stays not-ready until #17 wires it.
- Staging uses Azurite; a production Blob backup/restore has not been exercised.
