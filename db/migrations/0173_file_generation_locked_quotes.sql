-- A package quotation pins workpaper and document totals before admission.
-- Historical batches keep their stored snapshot and accepted child contracts.
CREATE TABLE bb_file_generation_quotes (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES bb_users(id),
 project_id text NOT NULL,
 input_hash char(64) NOT NULL,
 quote jsonb NOT NULL,
 price_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 accepted_batch_id text REFERENCES bb_file_generation_batches(id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 CHECK(expires_at>created_at)
);
CREATE INDEX ON bb_file_generation_quotes(owner_user_id,project_id,created_at);
CREATE FUNCTION bb_guard_file_generation_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'File quotation history is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'accepted_batch_id') IS DISTINCT FROM (to_jsonb(OLD)-'accepted_batch_id')
    OR OLD.accepted_batch_id IS NOT NULL AND NEW.accepted_batch_id IS DISTINCT FROM OLD.accepted_batch_id THEN
   RAISE EXCEPTION 'File quotation is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_file_generation_quote_immutable BEFORE UPDATE OR DELETE ON bb_file_generation_quotes FOR EACH ROW EXECUTE FUNCTION bb_guard_file_generation_quote();
