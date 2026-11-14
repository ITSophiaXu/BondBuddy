# Backend manual retry validation — 2026-11-13

This note records observed tool outputs and review results; it is not a redirected raw stdout log. Working branch: `fix/model-payload-recovery-20261113` (PR 1302 follow-up).

## Final status

Backend implementation and self-tests completed. No deployment, production mutation, schema migration or real model invocation was performed.

## Commands and outcomes

Executed from the isolated worktree `C:/Users/yingx/.codex/worktrees/model-payload-recovery/BondBuddy-admin-task-status-20261113`:

- `node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json` — PASS, exit 0.
- `node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json` — PASS, exit 0 after final CAS/route fixes.
- `node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json` — PASS, exit 0 after the final result fixture correction.
- `node packages/contracts/dist/check-examples.js` — PASS, exit 0; `validated 179 synthetic examples + 12 internal library examples and recovery/conflict/usage invariants`.
- `node --test apps/api/dist/file-authoring-recovery.test.js apps/api/dist/provider-run-events.test.js` — PASS, 5 tests / 0 failures.
- `node --test apps/worker/dist/file-authoring-payload-recovery.pg.test.js apps/worker/dist/unified-timeout-recovery.test.js` — the existing timeout subtest PASSED (45,245.0613 ms). This combined invocation exited 1 because the new manual retry case exposed the timestamp CAS bug described below.
- Final targeted rerun: `node --test apps/worker/dist/file-authoring-payload-recovery.pg.test.js` — PASS, exit 0; 1 suite / 1 test / 0 failures; test 88,521.5819 ms, total 98,223.2825 ms. Only the previously failed suite was rerun after fixing the manual path; the existing timeout path was unchanged by that fix.
- `git diff --check -- apps/api/src/queue.ts apps/api/src/server.ts packages/contracts/src/index.ts packages/contracts/src/worker-runtime.ts packages/contracts/src/run-retry.ts apps/worker/src/file-authoring-payload-recovery.pg.test.ts` — PASS, exit 0; Git emitted only the checkout's existing LF/CRLF normalization notices.

The PostgreSQL commands used `BB_TEST_DATABASE_URL` pointed exclusively at a dedicated local test container. Each file cloned the migrated template database and dropped its clone on completion. No production connection string was used.

## Issues found and resolved during integration

1. Attaching the existing conditional `RunResponse` directly to Fastify's response serializer caused `FST_ERR_SCH_SERIALIZATION_BUILD`. The new retry POST now follows the existing resume route and returns `runDto` directly; OpenAPI still declares `RunResponse`. The real route boot and API calls passed in the final suite.
2. Comparing a PostgreSQL microsecond timestamp against a Node `Date` truncated to milliseconds could treat the named attempt itself as newer. The final query excludes the named attempt and compares database timestamps directly in SQL. The first retry, duplicate request and stale-attempt cases all passed afterward.
3. The retained-result fixture was changed to use `providerResultObjectKey` and a `pending_reconcile` observation, so it tests valid persisted result evidence rather than an invalid result reference.

## Verified behaviors

- Owner-scoped GET eligibility and POST retry through real Fastify endpoints.
- HTTP 413 plus a valid checkpoint immediately queues the original run; the checkpoint authorizes restoring the existing working files.
- An old, stopped `MODEL_TURN_FAILED` first-pass call without a checkpoint requires explicit `restart_materials` confirmation. The original run/input and reservation are retained; the next claim accepts attempt 2. Unsaved working files are not claimed to survive.
- Same-request concurrent retries produce one transition. A same-request replay after a newer attempt does not authorize that newer attempt. A fresh request for an old attempt returns 409. Reusing the request ID with another attempt returns 409.
- A background recovery sweep winning the race is absorbed idempotently without another queue transition.
- Original reservations, credit events/balances and unknown supplier usage remain unchanged by retry.
- Active leases, unknown process exit, contradictory observations, existing results, unavailable/invalid checkpoints, pending user pause, billing cancellation and actual wallet isolation prevent resend.
- Foreign ownership, missing authentication, missing CSRF and foreign Origin are rejected.
- Normal `user_paused` eligibility returns `resume` and continues to use the existing resume endpoint.
- Existing automatic retry bounds, transaction rollback, concurrency, missing snapshots, user/credit pause, recharge, cancellation, run-kind isolation and dedicated cursor rotation still pass. Twenty blocked payload candidates plus twenty-one old unknown calls do not starve the next eligible payload task.

## Final review and scope limits

No blocking backend issue remains after the final passing suite. `payload_bounds` independently reviewed the run/job lock order, worker restart/restore paths, original-input binding, unknown-usage preservation, owner boundary and original billing reuse.

Manual restart is intentionally restricted to `file-authoring-v1`, adapter `codex-file-authoring-2`, one unresolved stopped attempt, unknown usage, no saved result anywhere in the job and no recovery snapshot. It does not convert arbitrary provider uncertainty into a retry permission. Checkpoint restore revalidates the private files and hashes in the worker before another model call. Retry budgets remain two per logical call and six per run, including owner-confirmed restarts.

The tests use real API/database transitions and synthetic model observations/materials; no real supplier generation or output quality was evaluated.

## Cleanup

- Container: `bb-payload-manual-retry-20261113-pg`.
- Verified ownership label: `bondbuddy.task=model-payload-recovery-20261113`.
- Local-only binding was `127.0.0.1:56228`; temporary data used tmpfs.
- Repository migration runner applied 178 migrations successfully.
- A post-test database query found no remaining `bb_retry_test_t%` clones.
- The verified owned container was removed successfully with `docker rm --force bb-payload-manual-retry-20261113-pg`.
