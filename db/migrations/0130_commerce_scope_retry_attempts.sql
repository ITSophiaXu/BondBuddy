-- A failed attempt releases its hold; the accepted business contract can then
-- be retried by a new run without losing the immutable history of either attempt.
ALTER TABLE bb_commerce_scope_runs DROP CONSTRAINT bb_commerce_scope_runs_pkey;
ALTER TABLE bb_commerce_scope_runs DROP CONSTRAINT bb_commerce_scope_runs_owner_user_id_scope_quote_id_key;
ALTER TABLE bb_commerce_scope_runs DROP CONSTRAINT bb_commerce_scope_runs_run_id_key;
ALTER TABLE bb_commerce_scope_runs ADD PRIMARY KEY(run_id);
CREATE INDEX bb_commerce_scope_runs_scope ON bb_commerce_scope_runs(owner_user_id,scope_quote_id,bound_at);

-- Serialize the same owner even when this table is written without the API.
-- The original guard still verifies the exact quote, plan and new reservation.
CREATE FUNCTION bb_commerce_scope_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce-coverage:'||NEW.owner_user_id,0));
 IF EXISTS(
  SELECT 1 FROM bb_commerce_scope_runs prior_attempt
   JOIN bb_runs prior_run ON prior_run.owner_user_id=prior_attempt.owner_user_id AND prior_run.id=prior_attempt.run_id
   LEFT JOIN bb_credit_reservations prior_hold ON prior_hold.owner_user_id=prior_run.owner_user_id
    AND prior_hold.id=prior_run.reservation_id AND prior_hold.run_id=prior_run.id
  WHERE prior_attempt.owner_user_id=NEW.owner_user_id AND prior_attempt.scope_quote_id=NEW.scope_quote_id
   AND prior_attempt.run_id<>NEW.run_id AND
    (prior_run.state NOT IN ('failed','cancelled','rejected')
     OR prior_run.reservation_id IS NOT NULL AND prior_hold.state IS DISTINCT FROM 'released'))
 THEN RAISE EXCEPTION 'Scope already active or delivered, or previous reservation not released' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_commerce_scope_run_attempt_valid BEFORE INSERT ON bb_commerce_scope_runs
 FOR EACH ROW EXECUTE FUNCTION bb_commerce_scope_attempt_guard();
