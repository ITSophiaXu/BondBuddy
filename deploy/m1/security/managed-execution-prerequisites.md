# Managed execution database prerequisites (#1484)

Status: the fix and production release are merged. On 2026-11-17 the database, API, controller, future templates and existing node were verified to contain the fix; actual authoring/review identities passed preflight and all 74 runtime hashes matched. The active task and current-epoch idle drain/stop-charging still require final observation. See [deployment evidence](../../../docs/acceptance/managed-db1484-partial-deployment-2026-11-17.md). Runtime verification does not establish user acceptance.

## Cause and scope

On 2026-11-16 the legacy Azure worker used `bondbuddy`, while elastic authoring/review services used restricted per-service roles. The capacity sequence and reservation finalization grants from #1473/#1474 did not cover the evidence gate's direct table lock or reads of `bb_project_file_check_attempts`. PostgreSQL denied `LOCK TABLE bb_evidence_gate_events IN SHARE MODE` at 18:09:33 Beijing time. Prior success under the legacy identity did not validate the elastic identities.

Migration 0190 adds `public.bb_lock_evidence_gate(boolean)`. It preserves SHARE / SHARE ROW EXCLUSIVE table locks, including serialization with old direct-lock callers. It runs under a trusted migration owner, fixes `search_path` to `pg_catalog`, qualifies its sole table target, rejects NULL, and revokes PUBLIC execution. It changes no rows. The caller still needs its existing SELECT and narrowly scoped INSERT privileges to read or append gate events; it gains no UPDATE, DELETE or TRUNCATE on the gate, nor INSERT on recovery audit events.

The role-specific SQL combines the explicit 0179/0182 prerequisites, reservation finalization, file-check reads and lock-function execution. It is an additive delta to an already reviewed consumer ACL, not a provisioning policy for arbitrary roles. Startup checks the actual `current_user` before runtime registration, including every granted activity INSERT/UPDATE column. Missing requirements produce `MANAGED_DATABASE_PRIVILEGES_MISSING:<names>` before enrollment and work claiming. This checks these known prerequisites, not every SQL path in the product.

## Release order (designated release chat only)

1. Follow `docs/runbooks/m1-split-deployment.md`, lock the environment's release, inspect active work, and record the actual component versions, runtime database identities and rollback files. Reconcile this change with other migrations in the fixed release candidate.
2. Apply migration 0190 using the existing trusted database migration identity. Do not assign function ownership to a restricted consumer. Inspect `proowner`, `prosecdef`, `proconfig` and `proacl` in `pg_proc`; PUBLIC must not have EXECUTE.
3. Apply the following once for each reviewed authoring/review database identity, using the existing privileged connection without logging its credential:

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v runtime_role=bb1361_formal_n1_author_v1 -f deploy/m1/security/managed-execution-prerequisites.sql
   ```

   The observed four identities were `bb1361_formal_n1_author_v1`, `bb1361_formal_n1_review_v1`, `bb1361_formal_n2_author_v1`, and `bb1361_formal_n2_review_v1`. Reconfirm current identities rather than treating this list as discovery. Execute for all applicable roles, even when a node is stopped. Future role provisioning must apply the same reviewed delta before enrollment. The script is transactional and repeatable; it neither creates roles nor grants membership/default privileges.
4. The shared API module is also used by legacy services and API operations. For every such actual caller that is not the function owner, explicitly grant `EXECUTE ON FUNCTION public.bb_lock_evidence_gate(boolean)` to its reviewed database role before updating its code. Do not grant execution to PUBLIC. Existing broad table privileges do not automatically imply function execution.
5. Release the updated `apps/api` evidence-gate module and `apps/worker` enrollment/preflight together to affected components. Existing production execution nodes use pinned overlays: a develop merge or SQL grant alone does not update their bundled module. Rebuild the versioned overlays and source manifests through the normal release procedure, include the new preflight module, and update both existing nodes and future launch templates. Do not silently edit retained historical recovery bundles or manifests.
6. Under each actual consumer identity, run `assertManagedDatabasePrivileges`, verify missing privileges refuse enrollment, and check registration/readiness with the released code. Validate an authorized task through admission, result persistence, final artifact and settlement. Check actual node versions, SQL errors, evidence-gate behavior and capacity release. Historical failed runs need separate authorized recovery/reconciliation; this fix does not retry them automatically.

## Rollback

Keep the additive migration and audit history. If reverting code, note that the previous direct LOCK remains incompatible with restricted roles; restoring that binary is not a functional rollback for those roles. Drain affected consumers through the release procedure and restore a verified compatible code/configuration pair. Do not widen audit-table rights or roll back the whole database to make an old binary work. Restore only recorded role-specific grants if required and only after the new code has been removed from all affected consumers.

## Local regression boundary

`apps/worker/src/managed-database-permissions.pg.test.ts` uses PostgreSQL 16 and the existing captured **authoring** ACL fixture. It reproduces both remaining denials after the earlier two-item fix, checks idempotent minimal grants, missing individual column privileges, real startup refusal, concurrent/legacy locks and search-path spoofing. It also exercises the real capacity/journal/child-process/result/Word/terminal code, with synthetic enrollment and a local fake supplier; blob storage is in memory. It is not a four-role snapshot replay, browser acceptance, Azure storage test, real DeepSeek call, or generated-content quality review.

Material-format and integrity-browser defects (#1476/#1477) are outside this permissions fix. Final unified acceptance and production symptom verification remain with the designated integration/release chats.

## Validation record (2026-11-16)

- PostgreSQL 16 applied the complete migration chain through 0190 to a new isolated database. Windows checkout CRLF was normalized to LF in a temporary test copy because the existing 0180 migration matches older function text literally; no historical migration was edited.
- `npm run build -w @bondbuddy/worker -- --declaration`, `npm run build -w @bondbuddy/api -- --declarationDir .types-validation`, and `npm run build -w @bondbuddy/web` passed. The contracts, domain and rule packages were also built. The existing API test imports worker output, so a cold standard build lacked worker declarations; the API's re-emission then collided with imported API declarations. Emitting worker declarations and directing API declaration output to a temporary directory resolved the validation setup. This is not a claim that the unmodified root `npm run build` works on a cold checkout.
- `npm run check:contracts`: 72 tests passed, zero failed/skipped; 179 synthetic API examples, 12 internal library examples and four lifecycle examples validated.
- `node --test apps/worker/dist/managed-database-permissions.pg.test.js`: 9 passed (eight subtests plus parent), zero failed/skipped, using Linux Node 22.23.3 and PostgreSQL 16. The exact permission failure was reproduced before applying the delta; all eight security/execution checks then passed. No real supplier or production data was used.
- `node --test apps/worker/dist/managed-run-recovery.pg.test.js`: 10 passed (nine subtests plus parent), zero failed/skipped, in a dedicated PID namespace. It also passed when run sequentially after the new permissions suite. Actual two-slot retry, terminal settlement and append-only recovery audit behavior were retained.
- `node --test apps/worker/dist/model-call-budget.pg.test.js`: 6 passed, zero failed/skipped. Set `BB_MODEL_EXECUTION_HOST_ID` to a synthetic 64-character hexadecimal identity in containers without `/etc/machine-id`. The existing test still rejected five slots after the runtime had adopted the eight-slot ceiling; its assertion now accepts five/eight and rejects nine. No runtime capacity policy changed.
- `node --test apps/api/dist/execution-node-eight.pg.test.js`: 1 passed, zero failed/skipped, with templates copied onto the container's local filesystem. A frozen 250-item synthetic batch reached eight overlapping real child processes, saved 16 synthetic Word artifacts, drained successfully and left zero model holders. Upstream supplier calls: zero.
- Run native process recovery suites as the only test entrypoint in their own PID namespace, not via `docker exec` alongside other tests. Provide the repository's `knowledge` directory to the eight-slot fixture and a fresh dedicated database because that fixture writes directly to its configured database. Native dependencies must reside on an executable mount. Initial attempts with shared processes, missing knowledge files or a noexec tmpfs were invalid environment setups, not passing regression evidence.
