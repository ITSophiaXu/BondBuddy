-- A verified synchronous denial is terminal, with a separate expansion fence.
-- No existing unknown operation or archive is rewritten by this migration.
ALTER TABLE bb_execution_cloud_operations ADD COLUMN authorization_denial jsonb;
ALTER TABLE bb_execution_capacity_policy
 ADD COLUMN launch_blocked_by_operation_id text REFERENCES bb_execution_cloud_operations(operation_id),
 ADD COLUMN launch_recovery_review jsonb;

-- Preserve terminal denial and its original immutable operation even after resume.
CREATE FUNCTION bb_execution_denial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.authorization_denial IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Terminal authorization denial immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_denial_immutable BEFORE UPDATE ON bb_execution_cloud_operations
 FOR EACH ROW EXECUTE FUNCTION bb_execution_denial_immutable();
