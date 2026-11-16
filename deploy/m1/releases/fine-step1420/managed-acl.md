# Managed worker performance-table permissions

The four existing managed worker roles are `NOINHERIT`; production has no application default ACL. Canonical migration `0185_performance_spans.sql` creates the two timing tables without granting those roles access. Apply `managed-performance-grants.sql` as `bondbuddy` after that exact migration, within the controlled, drained release sequence. Keep the existing 187 migration records and add only 0185 (188 total); this ACL operation is recorded separately and does not run other migrations.

The script grants SELECT on the two telemetry tables and only the INSERT/UPDATE columns used by `persistPerformanceBatch`. It creates no roles or memberships and grants no default, business-table, DELETE, TRUNCATE, purge, identity-update, or server-recorded timestamp/transaction rights. API and ops retain their existing owner access. Existing SELECT access to `bb_runs(id,owner_user_id,project_id,task_kind)` and `bb_jobs(id,run_id,owner_user_id)` must be confirmed before execution.

On 2026-11-16, an isolated PostgreSQL 16.15 instance ran the actual frozen writer (`48b5792718c4162c0cd10272edbd4c585941c14fa2bfab148640cee0472c5b22`) against the canonical LF migration (`20f7e159dca10fc86137f03e93d79a073c1787b4e6455693314a4f0d83dc347b`). All 70 checks passed, with zero failures or skips. The four roles could insert, finalize and replay telemetry; the forbidden operations were denied. SQL reapplication was idempotent. Node was v24.22.1 on Windows; PostgreSQL ran in a local Linux container. No production service or model was contacted. The synthetic rows and dedicated container were removed. The JSON result is retained alongside this document.

To repeat, use a fresh, disposable PostgreSQL instance bound exclusively to `127.0.0.1`, with owner `bondbuddy` and a database named `bb_1420_acl_<unique_suffix>`. This test creates cluster roles with the exact production role names, so do not point it at a shared development instance. Pass a built source directory containing the real timing writer, this grant SQL, the loopback connection URL, an output JSON path, and the canonical migration file:

```text
node test-managed-performance-acl.mjs <built-logging-source> managed-performance-grants.sql <local-test-url> <result.json> <canonical-0185.sql>
```

This is scoped permission validation, not a full release gate or evidence of production deployment. At rollback, the added timing tables and grants can remain while old code is restored; deleting them would destroy diagnostic data and is not part of this release.

At 2026-11-16 04:29:16 UTC, a read-only production check confirmed all 28 required SELECT column grants for those four roles. The exact result is in managed-required-read-columns.json. The test runner also rejects non-loopback hosts, other database prefixes, URL query parameters, and fragments before connecting.

Release metadata, SQL, fixtures and archives use the scoped `.gitattributes` raw-byte setting so Git does not change their measured hashes between Windows and Linux. Markdown uses LF. CRLF in retained evidence is preserved, and whitespace checks recognize CR as part of the line ending.
