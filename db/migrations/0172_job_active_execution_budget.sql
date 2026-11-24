-- Count only time owned by a running job. Queue, pause and recovery waits are excluded.
ALTER TABLE bb_jobs ADD COLUMN active_execution_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE bb_jobs ADD COLUMN active_started_at timestamptz;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_jobs_active_execution_ms_check CHECK (active_execution_ms >= 0);

CREATE FUNCTION bb_account_job_active_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'running' THEN NEW.active_started_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'running' AND (NEW.state <> 'running' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
    NEW.active_execution_ms := OLD.active_execution_ms + GREATEST(0,
      FLOOR(EXTRACT(EPOCH FROM (LEAST(now(), COALESCE(OLD.lease_until, now())) - COALESCE(OLD.active_started_at, now()))) * 1000)::bigint);
    NEW.active_started_at := NULL;
  END IF;
  IF NEW.state = 'running' AND NEW.active_started_at IS NULL THEN NEW.active_started_at := now(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_jobs_active_execution_before_write
  BEFORE INSERT OR UPDATE ON bb_jobs FOR EACH ROW
  EXECUTE FUNCTION bb_account_job_active_execution();

-- Existing running jobs start counting from this migration; no historical duration is guessed.
UPDATE bb_jobs SET active_started_at = now() WHERE state = 'running';

-- Review assistant messages use their own lease table and are also user-facing AI tasks.
ALTER TABLE bb_review_messages ADD COLUMN active_execution_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE bb_review_messages ADD COLUMN active_started_at timestamptz;
ALTER TABLE bb_review_messages ADD CONSTRAINT bb_review_messages_active_execution_ms_check CHECK (active_execution_ms >= 0);

CREATE FUNCTION bb_account_review_message_active_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reply_status = 'running' AND (NEW.reply_status <> 'running' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
    NEW.active_execution_ms := OLD.active_execution_ms + GREATEST(0,
      FLOOR(EXTRACT(EPOCH FROM (LEAST(now(), COALESCE(OLD.lease_until, now())) - COALESCE(OLD.active_started_at, now()))) * 1000)::bigint);
    NEW.active_started_at := NULL;
  END IF;
  IF NEW.reply_status = 'running' AND NEW.active_started_at IS NULL THEN NEW.active_started_at := now(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_review_messages_active_execution_before_update
  BEFORE UPDATE ON bb_review_messages FOR EACH ROW
  EXECUTE FUNCTION bb_account_review_message_active_execution();

UPDATE bb_review_messages SET active_started_at = now() WHERE reply_status = 'running';
