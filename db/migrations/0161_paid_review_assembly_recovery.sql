-- A private platform repair may deliver its exact completed full-review result
-- after the failed task's original charge has already been fully released.
-- A checkpoint flag alone never authorizes this exception.
CREATE FUNCTION bb_review_assembly_recovery_credit_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT r.channel='production' AND r.task_kind='review' AND r.billing_mode='fixed_credits' AND EXISTS(
  SELECT 1 FROM bb_jobs j
  JOIN bb_credit_reservations h ON h.id=r.reservation_id AND h.run_id=r.id AND h.owner_user_id=r.owner_user_id
  JOIN bb_credit_quotes q ON q.id=h.quote_id AND q.owner_user_id=h.owner_user_id AND q.project_id=r.project_id AND q.task_type='full_review'
  JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
  JOIN bb_review_executions x ON x.owner_user_id=r.owner_user_id AND x.project_id=r.project_id AND x.run_id=r.id AND x.operation='full_review'
  JOIN bb_model_call_attempts a ON a.id=j.checkpoint#>>'{review_assembly_recovery,attempt_id}' AND a.owner_user_id=r.owner_user_id AND a.job_id=j.id
  JOIN bb_call_usage u ON u.attempt_id=a.id AND u.usage_status='measured' AND u.conflicting_measurements=0
  JOIN bb_provider_result_refs p ON p.id=j.checkpoint#>>'{review_assembly_recovery,result_id}' AND p.attempt_id=a.id
  JOIN bb_snapshot_refs s ON s.id=a.prompt_snapshot_id AND s.owner_user_id=r.owner_user_id AND s.project_id=r.project_id AND s.run_id=r.id
  JOIN bb_run_events failed ON failed.owner_user_id=r.owner_user_id AND failed.run_id=r.id AND failed.seq::text=j.checkpoint#>>'{review_assembly_recovery,failure_event_seq}'
  JOIN bb_observability_errors error ON error.id=j.checkpoint#>>'{review_assembly_recovery,failure_error_id}'
  JOIN bb_run_events authorized ON authorized.owner_user_id=r.owner_user_id AND authorized.run_id=r.id
   AND authorized.state='queued' AND authorized.payload->>'reason'='review_assembly_requeued'
   AND authorized.payload->>'reuse_only'='true'
   AND authorized.payload @> ((j.checkpoint->'review_assembly_recovery')-'reuse_only')
  WHERE j.run_id=r.id AND j.owner_user_id=r.owner_user_id
   AND h.billing_policy='on_delivery' AND h.state='released' AND h.points>0 AND h.charged_points=0 AND h.finalized_at IS NOT NULL
   AND h.points=q.points
   AND EXISTS(SELECT 1 FROM bb_credit_events e WHERE e.owner_user_id=r.owner_user_id AND e.reservation_id=h.id AND e.run_id=r.id
    AND e.kind='release' AND e.event_key='release:'||h.id AND e.points=h.points)
   AND NOT EXISTS(SELECT 1 FROM bb_credit_events e WHERE e.reservation_id=h.id AND e.kind='settle')
   AND j.checkpoint#>>'{review_assembly_recovery,policy}'='review_assembly_v1'
   AND j.checkpoint#>'{review_assembly_recovery,reuse_only}'='true'::jsonb
   AND length(j.checkpoint#>>'{review_assembly_recovery,actor}')>0
   AND i.input_hash=r.input_hash AND i.manifest#>>'{review,operation}'='full_review'
   AND i.manifest#>>'{review,version}'='review_v1' AND i.manifest->>'project_kind'='review'
   AND x.snapshot->'input'=i.manifest#>'{review,input}' AND x.version::text=i.manifest#>>'{review,version_number}'
   AND r.input_revision::text=j.checkpoint#>>'{review_assembly_recovery,input_revision}'
   AND trim(r.input_hash)=j.checkpoint#>>'{review_assembly_recovery,input_hash}'
   AND failed.state='failed' AND failed.payload->>'reason'='processor_failed' AND failed.payload->>'error_code'='VALIDATION_FAILED'
   AND failed.seq<authorized.seq AND authorized.seq<=r.event_cursor AND h.finalized_at<=authorized.occurred_at
   AND error.owner_user_id=r.owner_user_id AND error.project_id=r.project_id AND error.job_id=j.id AND error.trace_id=r.id
   AND error.code='VALIDATION_FAILED' AND error.stage='model_generation' AND error.recovery_status='terminal'
   AND a.status='completed' AND a.logical_call_id~'^review-cli-v[23]-[a-f0-9]{24}$'
   AND a.logical_call_id=j.checkpoint#>>'{review_assembly_recovery,logical_call_id}'
   AND a.attempt_no::text=j.checkpoint#>>'{review_assembly_recovery,attempt_no}'
   AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts newer WHERE newer.job_id=j.id AND newer.id<>a.id
    AND (newer.created_at>=authorized.occurred_at OR newer.logical_call_id=a.logical_call_id AND newer.attempt_no>a.attempt_no))
   AND p.owner_user_id=r.owner_user_id AND p.project_id=r.project_id AND p.job_id=j.id AND p.run_id=r.id AND p.trace_id=r.id
   AND p.call_id=a.id AND p.logical_call_id=a.logical_call_id AND p.attempt_no=a.attempt_no AND p.prompt_snapshot_ref=s.id AND p.model_id=a.model_id
   AND p.result_schema_version='review-cli-'||substring(a.logical_call_id FROM '^review-cli-(v[23])-')
   AND trim(p.result_sha256)=j.checkpoint#>>'{review_assembly_recovery,result_sha256}'
   AND p.byte_size>0 AND p.byte_size<=10485760
   AND p.result_ref='users/'||r.owner_user_id||'/projects/'||r.project_id||'/provider-results/'||a.id||'-'||trim(p.result_sha256)||'.json'
   AND (SELECT count(*) FROM bb_provider_result_refs all_results WHERE all_results.attempt_id=a.id)=1
   AND s.snapshot_kind='model_request' AND s.input_revision=r.input_revision AND s.input_hash=r.input_hash
   AND s.id=j.checkpoint#>>'{review_assembly_recovery,prompt_snapshot_id}'
   AND trim(s.content_sha256)=j.checkpoint#>>'{review_assembly_recovery,prompt_sha256}'
   AND EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.owner_user_id=r.owner_user_id AND o.project_id=r.project_id AND o.job_id=j.id
    AND o.run_id=r.id AND o.attempt_id=a.id AND o.result_id=p.id AND o.prompt_snapshot_ref=s.id AND o.outcome='completed'
    AND o.usage_status='measured' AND o.finish_reason='stop' AND o.error_code IS NULL)
 );
$$;

DO $$ DECLARE definition text; marker text:='SELECT 1 FROM bb_jobs WHERE run_id=NEW.id AND checkpoint ? ''word_pair_delivery_recovery''';BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Original released-credit recovery guard missing';END IF;
 definition:=replace(definition,marker,'SELECT 1 FROM bb_jobs WHERE run_id=NEW.id AND (checkpoint ? ''word_pair_delivery_recovery'' OR bb_review_assembly_recovery_credit_ready(NEW))');
 EXECUTE definition;
END $$;
