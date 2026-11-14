# Windows billing host adapter

`windows-billing.mjs` executes the original `scripts/billing-functional/panel-session.test.mjs` in the gate's fresh Windows checkout. The generic dispatcher supplies its in-memory candidate/plan entry; this adapter does not accept a container's commands, paths or environment.

The host supplies an existing, matching `dependencyRoot` and an already-created private `evidenceRoot`. Dependencies are not installed on Windows. The root lock may differ only by CRLF; product workspace links must resolve into the current candidate, and Vite scratch data stays in its own directory. Raw tracked Git bytes are checked before and after the run. All seven required dependency/API/web builds run again on that checkout; an older build or receipt cannot substitute for them.

The adapter requires the existing Node 22+, Git, Edge, current local Docker Desktop Linux engine and local `postgres:16.10` image. It creates a private PostgreSQL bridge with a conflict-checked subnet and exactly one `127.0.0.1:55432` binding. The product test server retains its original loopback ports 5189/3089, database marker and orderly start/stop scripts. A real Windows-to-PostgreSQL probe runs before startup. No system route, TLS trust, installed software, production database or real payment/model service is changed.

The test remains a complete, unfiltered file with its original 90-second deadline, bounded by the original gate file budget. Return values contain its original stdout, stderr, exit, timeout and duration. Build/provision/cleanup failure throws with execution/evidence attached, and cannot become a passing result. Child processes receive a small host environment allowlist. On cancellation, only the adapter's own command process tree is stopped; cleanup still uses the original instance-bound stop endpoint. A service that cannot be confirmed stopped keeps its PostgreSQL available and blocks the gate.

Evidence records each actual command and output hash, exact candidate commit/tree, raw source manifest, resources and absence checks. The owned container and network are removed after the service exits. Its stopped synthetic database volume and local runtime remain for diagnosis; no original report is overwritten, no global prune is used, and no production acceptance is implied.

Pure regression command:

```sh
node --test scripts/pr-gate/host-adapters/windows-billing.test.mjs
```

This adapter is a capability implementation. Only its execution inside the same candidate's complete gate can count toward that candidate's gate receipt. The earlier standalone billing probe on `867dbb22` remains auxiliary evidence.

## PostgreSQL storage restore capability

`postgres-storage` runs the entire original `apps/api/src/storage-lifecycle.test.ts` (compiled by the current gate) in a short-lived container from the exact image of that gate's PostgreSQL 16 service. The container runs Node, not a second database daemon. It preserves all three cases, real `pg_dump`/`pg_restore`, Blob copy, restore verification, assertions and the 300000ms file deadline. It does not substitute the separate Blob backup test, whose database-dump fixture is synthetic.

The immutable candidate app/dependencies volume is read-only. Its manifest also binds the original test, compiled test and actual `db/verify-storage-restore.mjs`. The Node executable is copied byte-for-byte from the existing core image; SHA-256, version, module ABI, architecture, API/native-module import and both PG16 utility versions are checked inside the PG image's complete userspace. There is no package installation or cross-distribution PostgreSQL library overlay.

This profile requires the local offline gate's owned internal network. It shares only the exact current core container's network namespace and keeps the original isolated loopback PG/Azurite endpoints. It has no published ports, Docker socket, production settings, model credentials or added capabilities. Code and dependencies remain read-only, `/tmp` is bounded writable scratch, and the PostgreSQL image's data volume is explicitly masked by read-only tmpfs. The existing network-free native profiles keep their original isolation.

The receipt binds original TAP/exit/output hashes, the three-case/zero-skip count, source/tool/image identities and verified cleanup to the same candidate and gate run. An isolation or preparation failure remains a failure even after safe cleanup. The failed `f725e1d7` run remains evidence of the missing core-client capability; only a new fixed candidate's real full-file and complete-gate execution can establish that this fix passes.

## Authoring tests with local services

`service-authoring` supplies the existing worker image's Codex sandbox, Python and bubblewrap to exactly `file-authoring.pg.test.ts` (one case) and `review-file-delivery.pg.test.ts` (four cases). It runs both original complete files without changing their synthetic CLI fixtures, assertions or 300000ms file budgets. These tests use real isolated PostgreSQL/Azurite and the original local sandbox checks; model responses stay synthetic and no model credential is supplied. The mounted secret path contains only the existing synthetic sandbox canary.

This separate profile shares the same owned core internal network, while the original `native-sandbox`, `native-desktop` and `native-ocr` profiles retain `network:none`. The worker image, source bundle, exact test/helper files, permission probe, original outputs, service identities, before/after network checks and cleanup are bound into the receipt. It requires the complete gate's existing immutable worker image and current built candidate volume; it installs nothing and cannot substitute successful setup for the required one/four test results.
