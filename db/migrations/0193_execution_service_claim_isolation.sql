-- Keep the deployed function's owner, grants, security mode, and settings.
-- Startup still waits for every expected service. A ready node checks only
-- the claimant's own current service; peer expiry never proves termination.
DO $migration$
DECLARE
 definition text;
 before_guard constant text := $before$ IF n.id IS NULL OR n.epoch<>epoch_key OR n.state<>'ready' OR s.state IS DISTINCT FROM 'active'
  OR NOT s.ready OR s.heartbeat_at<clock_timestamp()-interval '30 seconds'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) service
   WHERE NOT EXISTS(SELECT 1 FROM bb_execution_node_sessions peer WHERE peer.node_id=n.id AND peer.epoch=n.epoch
    AND peer.service_id=service->>'service_id' AND peer.state='active' AND peer.ready AND peer.heartbeat_at>clock_timestamp()-interval '30 seconds'))$before$;
 after_guard constant text := $after$ IF n.id IS NULL OR n.epoch IS DISTINCT FROM epoch_key OR n.state<>'ready'
  OR s.state IS DISTINCT FROM 'active' OR s.ready IS DISTINCT FROM true
  OR s.heartbeat_at<=clock_timestamp()-interval '30 seconds'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) service
   WHERE service->>'service_id'=s.service_id)$after$;
BEGIN
 SELECT pg_get_functiondef('bb_execution_claim_context()'::regprocedure) INTO STRICT definition;
 IF length(definition)-length(replace(definition,before_guard,''))<>length(before_guard)
  OR position('IF occupied>=policy.node_model_limit THEN' in definition)=0 THEN
  RAISE EXCEPTION 'Unexpected execution claim gate';
 END IF;
 EXECUTE replace(definition,before_guard,after_guard);
END
$migration$;
