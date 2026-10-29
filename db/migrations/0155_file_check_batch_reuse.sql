-- Repeated zero-price checks reuse an already delivered exact manifest.
-- Historical attempts remain immutable; a reused run is not a new child attempt.
ALTER TABLE bb_project_file_check_batch_items ADD COLUMN reused_run_id text;
ALTER TABLE bb_project_file_check_batch_items ADD FOREIGN KEY(owner_user_id,reused_run_id) REFERENCES bb_runs(owner_user_id,id);
ALTER TABLE bb_project_file_check_batch_items ADD CHECK(reused_run_id IS NULL OR points=0);

CREATE FUNCTION bb_file_check_batch_reuse_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_project text; BEGIN
 IF NEW.points<>0 THEN RETURN NEW; END IF;
 SELECT project_id INTO target_project FROM bb_project_file_check_batches WHERE owner_user_id=NEW.owner_user_id AND id=NEW.batch_id;
 IF NEW.reused_run_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
  JOIN bb_project_file_check_quotes q ON q.owner_user_id=o.owner_user_id AND q.run_id=o.run_id
  JOIN bb_artifact_versions a ON a.owner_user_id=r.owner_user_id AND a.run_id=r.id AND a.id=r.artifact_id AND a.version=r.artifact_version
  WHERE o.owner_user_id=NEW.owner_user_id AND o.run_id=NEW.reused_run_id AND o.project_id=target_project AND o.operation='check'
   AND o.manifest=NEW.manifest AND o.result IS NOT NULL AND o.result_hash IS NOT NULL AND r.state='succeeded' AND a.delivery_status='available'
   AND NOT bb_task_item_was_refunded(o.owner_user_id,o.run_id,NEW.file_version_id)
   AND(q.points=0 OR EXISTS(SELECT 1 FROM bb_credit_reservations res WHERE res.owner_user_id=q.owner_user_id AND res.run_id=q.run_id AND res.quote_id=q.id AND res.state='settled' AND res.charged_points=q.points))
 ) THEN RAISE EXCEPTION 'Zero-price batch item requires an exact owned delivered result' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_file_check_batch_reuse_guard BEFORE INSERT ON bb_project_file_check_batch_items FOR EACH ROW EXECUTE FUNCTION bb_file_check_batch_reuse_guard();

CREATE FUNCTION bb_file_check_batch_attempt_paid_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bb_project_file_check_batch_items WHERE owner_user_id=NEW.owner_user_id AND batch_id=NEW.batch_id AND ordinal=NEW.ordinal AND (points=0 OR reused_run_id IS NOT NULL))
 THEN RAISE EXCEPTION 'A reused zero-price batch item cannot create a model attempt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_file_check_batch_attempt_paid_guard BEFORE INSERT ON bb_project_file_check_attempts FOR EACH ROW EXECUTE FUNCTION bb_file_check_batch_attempt_paid_guard();
