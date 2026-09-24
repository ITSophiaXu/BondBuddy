# M1-04 persistent API slice

This slice uses the merged `@bondbuddy/contracts` and does not extend the old Cowork backend or change the prototype. It adds `db/migrations/0001_m1_owner_data.sql` and `0002_artifact_download_grants.sql`, a PostgreSQL migration runner, a private Azure Blob adapter, and owner-scoped Fastify routes. All personal routes require a trusted `principal` adapter supplied by #7. The production entry point supplies none, so it rejects client headers, query IDs, and cookies that it cannot validate. A real adapter must validate the HttpOnly, Secure, SameSite session and return `csrfVerified`; mutations also require the configured allowed Origin. The current production entry point cannot create a project until #7 wires this adapter.

`/api/v1/runs/execute` is disabled in production with `501 CAPABILITY_NOT_READY` until #17 queue execution and #79 logging are integrated. The explicit test-only staging option records a `paused` run, event, and outbox atomically to prove ownership/idempotency; it never queues a model call or claims completion. Recognition, preflight, conversation, project event delivery, cancel, and resume also return 501. Artifact retrieval only serves rows from a trusted delivery writer with `passed` quality, `available` delivery, owner match, and fresh hash verification. Metadata creates a five minute download grant bound to the owner and artifact version; download rechecks the session and grant. There is no public artifact writer in this slice. Input snapshots reject requirement message IDs until a trusted message repository can verify them; rule/template/reference versions stay null until released registries exist. No synthetic tests establish live #6/#8 acceptance.

## Local validation

Use Node 22. `deploy/local/compose.yaml` binds PostgreSQL 16 to localhost port 55433 and Azurite Blob to localhost port 10000. It uses an ephemeral database and emulator storage, and is not a production configuration.

```bash
docker compose -f deploy/local/compose.yaml -p bondbuddy_m1_04 up -d --wait
export DATABASE_URL=postgresql://bondbuddy_local@127.0.0.1:55433/bondbuddy_local
npm ci
npm run migrate:api
npm run build
npm run check:contracts
BB_TEST_DATABASE_URL="$DATABASE_URL" BB_TEST_AZURITE_CONNECTION_STRING=UseDevelopmentStorage=true npm run test:api
```

The integration test uses synthetic PDF bytes only. It verifies two owner subjects cannot enumerate, associate, download, or delete one another's data; stale drafts return 409; snapshots remain unchanged after draft edits; retry with the same execution key reuses a run; a changed request with that key returns 409; and a forced outbox failure rolls back material registration. The test principal is injected only into an in-process Fastify instance.

## Upgrade, restore, and deletion decisions

Apply migrations in filename order using `npm run migrate:api` against the target database before starting an API revision. Migrations are append-only; there is no automatic destructive down migration. Before upgrade, take a transactionally consistent `pg_dump -Fc` plus a coordinated private Blob snapshot, retain the application revision and migration manifest, and test restore to a separate database/storage account. Example local database round trip:

```bash
pg_dump -Fc "$DATABASE_URL" -f /tmp/bondbuddy-m1-04.dump
createdb -h 127.0.0.1 -p 55433 -U bondbuddy_local bondbuddy_restore
pg_restore -h 127.0.0.1 -p 55433 -U bondbuddy_local -d bondbuddy_restore /tmp/bondbuddy-m1-04.dump
# For the synthetic integration fixture only:
RESTORE_DATABASE_URL=postgresql://bondbuddy_local@127.0.0.1:55433/bondbuddy_restore node db/verify-restore.mjs
```

Restore also requires Blob objects corresponding to database object keys; PostgreSQL backup alone cannot recover file bytes. Reconcile orphan uploads and deletion tombstones before reopening traffic. To roll back an application release, restore both database and Blob snapshots into an isolated environment, verify schema constraints and hashes, and then switch traffic. Do not reverse an applied migration in place.

Upload sessions expire in 15 minutes and can be retried with matching bytes; `complete` is idempotent after registration. The API verifies the stored size, SHA-256, declared MIME, and basic signature before creating an immutable material version. `persisted` means bytes exist, not that parsing/OCR succeeded; OCR and unsupported encrypted/unsafe content policy need later processors. Deleting a material marks its current access deleted but keeps bytes pinned by old snapshots/runs. A physical purge worker, orphan Blob cleanup, backup deletion replay, retention periods, encrypted ZIP detection, PDF safety scanning, and provider-side deletion evidence are still release decisions. Do not advertise an effective deletion deadline until these are implemented and tested.
