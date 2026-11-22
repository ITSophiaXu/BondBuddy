# Log diagnostics release backport (2026-11-22)

Status: scoped integration checkpoint, **not approved for production deployment**.

Base: `origin/master` `87a8e217c7a6436005bb9173f51da5b5f7e4f27b`.
Source: PR #1683 (`6d517f72acb39aa539774c36c77607f63ce66eb2`) and the applicable build/migration fixes from `develop`.

This backport includes structured execution timeout evidence, result failure classification, session creation time, runtime capture status, bounded tool/resource metrics, API and read-only diagnostic projections, and four new migrations (`0195`–`0198`). The previously deployed `0191` migration is byte-for-byte unchanged. It also moves the execution-node integration test to the worker package, matching the already merged build fix, and normalizes SQL line endings in the migration runner so a fresh Windows checkout can apply the existing `0180` migration.

The production baseline has no model gateway. This candidate records gateway measurement as `not_enabled`; it does not provide the gateway response timing part of #1681. The source PR's gateway change and its model-request dependency were excluded from this scoped backport. The team's diagnostics integration test file is likewise not on the production baseline; the candidate's read-only views were checked against an isolated PostgreSQL 16 instance.

Verification in this workspace:

- TypeScript compilation: contracts, domain, rule-pack registry, rule applicability context, API, worker, and web passed with workspace-local links to installed dependencies.
- Production Vite web bundle completed from `apps/web` (593 modules transformed).
- `node --test` Codex adapter and model-performance: 56/56 passed.
- API performance: 9/9 passed; web review timeline: 9/9 passed.
- Diagnostics SecurityTests: 12/12 passed. Full diagnostics Python suite on Windows had 5 Linux-only recovery errors (`fcntl`, `os.geteuid`, and shell execution), requiring Linux validation.
- Fresh isolated PostgreSQL 16: all migrations through `0198` applied. Diagnostics reader view installation passed, and the restricted role queried sessions, execution configs, result failures and performance spans. The temporary container was removed.

Before deployment: resolve #1681 gateway timing scope, run the complete exact-SHA Linux quality gate and real-model golden-case acceptance, obtain the private release receipt, validate the fixed local integration version with the user, and check live main/execution component versions, in-flight jobs, migration state, deployment locks and rollback preimages. No production service or database was changed by this checkpoint.
