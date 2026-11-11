-- Control intent survives wallet isolation without moving any funds. Recovery
-- still uses the original guarded terminal transition after independent resume.
ALTER TABLE bb_jobs ADD COLUMN billing_cancel_requested_at timestamptz;
ALTER TABLE bb_jobs ADD COLUMN billing_resume_stage text;
