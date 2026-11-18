// #79/#35 scheduled operations. The ops scheduler (apps/worker ops-scheduler) runs these tasks with
// PostgreSQL leases (migration 0028) so only one scheduler instance executes a due task.
// Kept in its own module so parallel PRs appending to index.ts do not collide.
export const OPS_SCHEDULED_TASKS = ['provider_reconcile', 'log_forward', 'log_health', 'storage_purge', 'storage_inventory', 'archive_retention', 'trial_health', 'worker_heartbeat', 'parse_backfill', 'backup_retention', 'library_sync', 'provider_balance'] as const;
export const OPS_SCHEDULE_RUN_STATUSES = ['succeeded', 'failed'] as const;
// Appended to OPS_ALERT_KINDS (admin-logs.ts) and the bb_ops_alerts kind check (migrations 0028, 0032).
// library_* alerts are raised by the #78 library_sync task; scope is the library source id.
export const OPS_SCHEDULER_ALERT_KINDS = ['scheduled_task_failed', 'library_source_stale', 'library_sync_failed'] as const;
// #35 off-host backups live in this private Blob container (never exported by blob-snapshot).
export const OFFHOST_BACKUP_CONTAINER = 'bb-backups';
export type OpsScheduledTask = typeof OPS_SCHEDULED_TASKS[number];
