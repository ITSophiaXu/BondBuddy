# M1 private storage lifecycle runbook

This runbook covers the bounded material Blob purge and expired orphan-upload cleanup in migration `0006_m1_storage_lifecycle.sql`. It does not establish a production retention deadline, supplier-side deletion proof, encrypted/unsafe-file scanning, or release acceptance. Production API execution remains disabled with `501 CAPABILITY_NOT_READY`.

## Safety model

- A material delete first sets `deleted_at`, writes one immutable tombstone per material version, and inserts `material.deleted` in one PostgreSQL transaction. Repeat delete by the same owner returns `204` without another outbox event. Other owners and unknown IDs receive the same `404`.
- PostgreSQL creates each material tombstone from the `deleted_at` transition and rejects later attempts to clear or rewrite that timestamp. Upload state transitions also reject moving a `deleting`/`purged` orphan back to an uploadable state.
- A tombstone pins the exact owner, project, object key, and SHA-256. It cannot be removed or returned from `purged` to a live state. The purge worker commits a claim before reading or deleting Blob bytes.
- Material is eligible only after the configured retention gate and only when no immutable input revision contains that material/version. Runs reference an input revision and artifacts reference a run, so both are conservatively pinned by that immutable input revision. Bound observability snapshots point back to the same revision. Input revisions currently have no governed release lifecycle; referenced material therefore remains stored indefinitely.
- Before delete, the worker verifies the object SHA-256. A mismatch is left untouched and recorded as a safe error code. If Azure reports success but PostgreSQL confirmation fails, replay treats an absent exact object as already removed and commits the tombstone/outbox transition.
- Orphan cleanup takes the upload row with `FOR UPDATE SKIP LOCKED`, transitions only expired `uploading`/`received` uploads with no material row to `deleting`, and creates the tombstone in the same transaction. API PUT, completion, and cleanup all serialize on that row. Each run queues at most 50 orphan uploads and claims/processes at most 50 tombstones; reduce this by setting the internal batch option in a controlled caller if needed.
- The summary's `pinned` count is a bounded count of eligible pending material tombstones held by immutable input revisions, capped at the batch size; it is not a lifetime total.
- Tombstone retry errors never store provider exception text, paths, or credentials. `last_error_code` is restricted to a small safe enum.

## Policy gates

The worker has no production defaults. The following must be explicit in the runtime configuration used by the worker:

```text
BB_STORAGE_PURGE_ENABLED=true
BB_STORAGE_MATERIAL_RETENTION_DAYS=<approved integer>
BB_STORAGE_ORPHAN_GRACE_HOURS=<approved integer>
DATABASE_URL=<private PostgreSQL connection>
AZURE_STORAGE_CONNECTION_STRING=<private Blob connection>
```

Only the exact value `true` enables processing. If the switch is absent or false, the command reports that it made no changes. If enabled while either policy value is absent or invalid, it exits nonzero before connecting to storage. An explicit zero is accepted and means no additional wait; it is not the default. Do not enable purge until legal, privacy, product, and operations owners approve both values and the reference-release behavior.

The policy is rechecked when each tombstone is claimed. Raising a retention/grace value delays existing work; lowering a value does not shorten an already recorded `eligible_at`. No business value is supplied by this PR.

## Apply and run

1. Back up PostgreSQL and private Blob storage as one coordinated recovery point. Pause API uploads and purge workers while taking the snapshots. Record the deployed application revision and the migration manifest.
2. Apply append-only migrations in filename order with `npm run migrate:api`. This task adds `0006`; it does not edit `0005` or the #79 observability implementation.
3. Keep the purge worker disabled until policy values are approved. For a one-off operator run after approval:

   ```bash
   npm run storage:lifecycle
   ```

   Configure the environment through the host's protected runtime configuration facility. The script builds the contracts/API and runs one batch. It does not start a scheduler. Set up an approved timer separately, with monitoring for nonzero exits and pending tombstones.
4. A successful batch reports only aggregate counts. A nonzero exit or a nonzero `failed` count means inspect the corresponding tombstone's safe `last_error_code` (`pin_check_failed`, `blob_read_failed`, `blob_delete_failed`, `blob_hash_mismatch`, `purge_attempt_failed`, or `blob_io_failed`), confirm database/Blob health and the exact hash, and retry after the stored backoff. Do not manually clear a hash mismatch or mark a tombstone purged.
5. For restore verification, restore the dump and copy the private Blob snapshot into a separate database and empty container/account first. Set `BB_STORAGE_RESTORE_CONNECTION_STRING` when the target account differs from the source account. Then run `db/verify-storage-restore.mjs` against that isolated pair with an authorized owner and an eligible, replayable tombstone fixture. The verifier checks referenced SHA-256 values, replays one tombstone, confirms the copied deleted object is absent, and exercises owner-scoped API reads. It intentionally changes the isolated restore target. Never point its restore variables at a live database/container.

The synthetic PostgreSQL/Azurite test additionally runs `pg_dump -Fc`/`pg_restore`, copies the fixture container, injects a disconnect after physical deletion, and replays the tombstone. Its test-only zero retention setting simulates an already-approved eligibility point; it is not a suggested production policy.

## Decisions still required

- Approved material retention and orphan-upload grace values, owner, legal basis, and how changes apply to existing tombstones.
- Whether/when immutable input revisions, runs, and artifacts may release their Blob pins. Until a reviewed reference-release mechanism exists, every snapshot reference pins bytes indefinitely.
- Production backup frequency, retention, encryption/key scope, region/account isolation, RPO/RTO, Blob consistency mechanism, restore authority, and traffic cutover/rollback procedure.
- What operators should do with permanent hash mismatches, unavailable objects, and tombstones pinned by old snapshots.
- Unsafe/encrypted file scanning and supplier-side deletion evidence remain separate work.
