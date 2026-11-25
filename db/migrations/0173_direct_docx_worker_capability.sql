-- Old workers omit this column and therefore never advertise direct DOCX support.
ALTER TABLE bb_worker_heartbeats
  ADD COLUMN run_kinds text[] NOT NULL DEFAULT '{}'::text[];
