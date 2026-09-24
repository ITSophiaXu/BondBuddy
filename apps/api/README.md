# M1 persistent API and M1-02 session slice

## #7 trusted session boundary

Migration `0003_m1_auth_sessions.sql` adds normalized E.164 phone identity, one-time challenges, versioned required agreement acceptance, idempotent `user.registered` outbox event, and revocable sessions. Apply it after `0001`/`0002`; never edit deployed migrations. Existing #8 owner IDs were test-only opaque subjects and are not silently converted into phone accounts. A production data migration needs an explicit verified identity mapping.

`/api/v1/auth/sms/challenges` accepts mainland 11 digit or `+86` form. A challenge lasts five minutes, can be resent after 60 seconds, and allows five issues per phone per hour; a resend invalidates the old challenge. Five wrong codes invalidate a challenge. The response is the same for new and existing phones and contains no OTP. Limits are per normalized phone, so colleagues sharing an IP are not blanket blocked. The six digit OTP is held only by the SMS transport during delivery and HMAC hashed in PostgreSQL; configure a high entropy `BB_AUTH_OTP_KEY` through the runtime secret facility. A failed provider send rolls back issuance and returns a generic error. The transport must not log codes or include them in errors.

`BB_ALLOWED_ORIGIN` must exactly match the browser origin. `BB_TERMS_VERSION` must be the currently published, reviewed required agreement version; clients submit it at verification. Agreement acceptance is recorded once per user/version; marketing consent is not implied. Access and refresh tokens are random opaque values stored only as SHA-256 hashes. `bb_session` expires in 15 minutes; `bb_refresh` rotates on `/auth/refresh` and has an absolute 30 day lifetime. Both are `Secure; HttpOnly; SameSite=Strict` cookies. `bb_csrf` is a separate readable `Secure; SameSite=Strict` cookie; authenticated mutations require its `X-BB-CSRF` echo and exact Origin. Challenge and verify require exact Origin and JSON requests. `/auth/logout` revokes both tokens; old access, refresh, material and artifact reads then fail. A normal browser close leaves the database session and server jobs intact.

The API production entry has **no SMS transport**. Challenge and verify fail closed with `CAPABILITY_NOT_READY` until an approved real supplier adapter, sender identity, account approval, credentials in the target environment, delivery receipt behavior, regional support, costs and privacy terms are documented and tested. The local integration test injects an in-process synthetic transport; no network route exposes it and it is not evidence of production SMS. `BB_AUTH_OTP_KEY` and `BB_TERMS_VERSION` alone do not enable sending. No gifted credits are created or displayed by this API. Account phone change, closure/refund flow and invitation attribution remain separate release work; the #7 Issue stays open for actual supplier and live acceptance.

The prototype `product-prototype/lib/auth.mjs` supplied interaction behavior and timing defaults only. Its JSON account store, demo code exposure, demo sessions and credit grant were not reused. The #8 routes retain their owner predicates; their production principal now comes from the PostgreSQL session instead of a client header. In-process principal injection remains solely for existing #8 tests and is absent from the production entry point.

The merged #8 slice uses `@bondbuddy/contracts` and does not extend the old Cowork backend or change the prototype. It adds `db/migrations/0001_m1_owner_data.sql` and `0002_artifact_download_grants.sql`, a PostgreSQL migration runner, a private Azure Blob adapter, and owner-scoped Fastify routes. #7 now resolves a verified PostgreSQL session in the production entry point; all personal routes reject unverified client headers, query IDs and cookies. Mutations require the configured allowed Origin and CSRF echo.

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

The integration tests use synthetic phones and PDF bytes only. #8 tests verify two owner subjects cannot enumerate, associate, download, or delete one another's data; stale drafts return 409; snapshots remain unchanged after draft edits; retry with the same execution key reuses a run; a changed request with that key returns 409; and a forced outbox failure rolls back material registration. The #7 test exercises real PostgreSQL sessions and cookie-backed #8 project/material routes: new and existing phone challenge shape, shared IP, wrong/expired/replayed/resend codes, hourly issue limit, agreement version, one registration event, token rotation, logout, cross-account isolation, and Origin/CSRF denials. The synthetic SMS provider and legacy #8 principal are injected only into in-process Fastify tests.

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
