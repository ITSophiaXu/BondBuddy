-- A run retains the input and idempotency identity with which it was accepted.
-- Supplementation must append a separately authorised execution version, never
-- overwrite this origin. This guard does not introduce adoption or pricing.
CREATE FUNCTION bb_guard_run_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.owner_user_id, NEW.project_id, NEW.input_revision,
         NEW.input_hash, NEW.execution_request_id, NEW.request_hash)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.owner_user_id, OLD.project_id, OLD.input_revision,
         OLD.input_hash, OLD.execution_request_id, OLD.request_hash) THEN
    RAISE EXCEPTION 'run origin input and execution identity are immutable'
      USING ERRCODE='23514', CONSTRAINT='bb_run_origin_immutable';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER bb_run_origin_immutable BEFORE UPDATE ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_run_origin();
