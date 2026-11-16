-- An explicitly reviewed local preflight failure is not a cloud acceptance.
-- Keep the complete unknown operation, including its original dispatch timestamp.
ALTER TABLE bb_execution_cloud_operations ADD COLUMN local_preflight_cancellation jsonb;

CREATE FUNCTION bb_execution_local_cancellation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.local_preflight_cancellation IS NOT NULL THEN RAISE EXCEPTION 'Local cancellation requires original operation'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.local_preflight_cancellation IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Terminal local cancellation immutable' USING ERRCODE='55000';
 END IF;
 IF NEW.local_preflight_cancellation IS NOT NULL AND OLD.local_preflight_cancellation IS NULL THEN
  IF OLD.action<>'start' OR OLD.state<>'unknown' OR OLD.dispatched_at IS NULL
   OR OLD.provider_request_id IS NOT NULL OR OLD.cloud_observation IS NOT NULL
   OR OLD.rejection_evidence IS NOT NULL OR OLD.run_acceptance IS NOT NULL OR OLD.authorization_denial IS NOT NULL
   OR OLD.node_preimage IS NULL OR OLD.reserved_node_preimage IS NULL
   OR NEW.state<>'cancelled' OR NEW.revision<>OLD.revision+1 OR NEW.completed_at IS NULL
   OR NEW.local_preflight_cancellation->>'version' IS DISTINCT FROM 'execution-local-start-cancellation-v1'
   OR NEW.local_preflight_cancellation->>'reason' IS DISTINCT FROM 'WARM_START_CLOUD_MANIFEST_DRIFT'
   OR NEW.local_preflight_cancellation->'original_operation' IS DISTINCT FROM to_jsonb(OLD)
   OR COALESCE(NEW.local_preflight_cancellation->>'proof_sha256','') !~ '^[a-f0-9]{64}$'
   OR COALESCE(NEW.local_preflight_cancellation->>'inventory_sha256','') !~ '^[a-f0-9]{64}$'
   OR (to_jsonb(NEW)-ARRAY['state','revision','completed_at','local_preflight_cancellation'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','completed_at','local_preflight_cancellation'])
   THEN RAISE EXCEPTION 'Local non-submission unproven' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_local_cancellation_immutable BEFORE INSERT OR UPDATE ON bb_execution_cloud_operations
 FOR EACH ROW EXECUTE FUNCTION bb_execution_local_cancellation_immutable();

-- All existing identity, complete preimage and no-work fences remain in force.
CREATE OR REPLACE FUNCTION bb_execution_guard_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE completed boolean;
BEGIN
 IF ROW(NEW.account_id,NEW.region,NEW.instance_id) IS DISTINCT FROM ROW(OLD.account_id,OLD.region,OLD.instance_id) THEN RAISE EXCEPTION 'Cloud identity immutable'; END IF;
 IF OLD.state='stop_submitted' AND (NEW.state<>OLD.state OR NEW.epoch<>OLD.epoch) THEN
  SELECT EXISTS(SELECT 1 FROM bb_execution_cloud_operations o WHERE o.operation_id=OLD.stop_operation_id AND o.state='completed'
   AND o.action IN ('stop','destroy') AND o.account_id=OLD.account_id AND o.region=OLD.region AND o.instance_id=OLD.instance_id AND o.epoch=OLD.epoch
   AND o.cloud_observation IS NOT NULL) INTO completed;
  IF NOT completed OR NEW.state<>'stopped' OR NEW.epoch<>OLD.epoch THEN RAISE EXCEPTION 'Stop outcome unresolved'; END IF;
 END IF;
 IF NEW.epoch<>OLD.epoch AND OLD.state='starting' AND NEW.state='stopped' AND NEW.revision=OLD.revision+1
  AND EXISTS(SELECT 1 FROM bb_execution_cloud_operations o WHERE o.operation_id=OLD.cloud_start_operation_id
   AND o.action='start' AND o.state='cancelled' AND (o.dispatched_at IS NULL OR (o.local_preflight_cancellation->>'version'='execution-local-start-cancellation-v1'
    AND o.local_preflight_cancellation->'original_operation'->'reserved_node_preimage'=to_jsonb(OLD)))
   AND o.provider_request_id IS NULL
   AND o.reserved_node_preimage=to_jsonb(OLD) AND o.node_preimage-'revision'=to_jsonb(NEW)-'revision')
  AND NOT EXISTS(SELECT 1 FROM bb_execution_node_sessions WHERE node_id=OLD.id AND epoch=OLD.epoch)
  AND NOT EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=OLD.id)
  AND NOT EXISTS(SELECT 1 FROM bb_jobs WHERE execution_node_id=OLD.id AND lease_token IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM bb_review_messages WHERE execution_node_id=OLD.id AND lease_token IS NOT NULL)
  THEN RETURN NEW; END IF;
 IF NEW.epoch<>OLD.epoch AND (OLD.state<>'stopped' OR EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id=OLD.id)) THEN RAISE EXCEPTION 'Prior node epoch not safely stopped'; END IF;
 RETURN NEW;
END $$;
