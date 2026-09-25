# Runbook: #79 log alerts and recovery

All alerts are rows in `bb_ops_alerts`, visible through `GET /api/v1/admin/alerts`. External paging is wired by #35.

| Alert | Meaning | Action |
|---|---|---|
| `log_sink_unavailable` (critical) | The sink rejected a batch. Nothing was marked delivered | Check the sink (file path, disk, permissions). Once it is fixed, keep running `log-ops forward`, and the backlog replays. Consumers dedupe on `delivery_key` |
| `log_backlog_stale` (critical) | The oldest undelivered observability event is older than the threshold | Check that the forwarder timer runs and that the sink is healthy. Replay is safe to repeat |
| `evidence_persist_failed` (critical) + gate `paused` | An execution-evidence write failed at the infrastructure level. New external model calls are refused with 503 | 1. Restore PostgreSQL (connectivity, disk, failover). 2. Reconcile in-flight attempts with `pending_reconcile` status using the [provider result reconciliation runbook](provider-result-reconciliation.md). Do not resend them. 3. As a `log_operator`, `POST /api/v1/admin/evidence-gate/resume {"reason_code":"db_recovered"}`. 4. Confirm with `GET /admin/evidence-gate` that both `state` and `process_state` are `open`. Restart any worker whose process still holds an unpersisted pause |
| `usage_conflict` (warning) | Measured reports disagree for one attempt. Its tokens are excluded | Compare the raw observations in the job timeline with supplier evidence, then, as a `log_operator`, `POST /admin/attempts/{id}/usage-corrections` choosing the correct observation, or choose `unknown`. Raw rows are never edited |
| `retention_purge_failed` (warning) | A Blob delete failed | Check storage availability and rerun `log-ops retention`. It is idempotent: an already-deleted blob only gets its tombstone |

## Crash recovery facts

- Forwarder crash after the sink accepted a batch: leases expire, and the same `delivery_key`s are re-sent.
- NDJSON writer failure on a partial/corrupt line or unsafe file/lock permissions: forwarding stays unacknowledged and raises `log_sink_unavailable`. Preserve a restricted copy of the file, reconcile the damaged tail and its `delivery_key` against PostgreSQL outbox/receipts, repair only with a reviewed operator action, then replay. Never replace the file with an empty one or silently discard a complete line: the file itself is the durable dedupe journal. Keep the active file and `.lock` inode stable across retries.
- API or worker crash: jobs, attempts and terminal events are committed with their outbox rows. Nothing is written only to memory.
- Grants: create them with `grantOperator` in a reviewed maintenance session (no HTTP route). Revoke with `revokeOperator`, which takes effect on the next request.
