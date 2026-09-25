-- #35 off-host backups: the ops scheduler records when each task last succeeded, so operators can
-- see how old the newest successful backup_retention (or any other task) run is, even after failures.
ALTER TABLE bb_ops_schedule ADD COLUMN last_succeeded_at timestamptz;
