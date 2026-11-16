-- PR #1420: telemetry-only rights for the four existing managed worker roles.
-- Apply after canonical 0185, while the managed release is drained and locked.
-- No role creation, membership, default privileges, business-table or purge rights.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
DO $guard$
DECLARE role_name text;
BEGIN
 IF current_user <> 'bondbuddy' THEN RAISE EXCEPTION 'expected application owner bondbuddy'; END IF;
 IF to_regclass('public.bb_performance_sessions') IS NULL OR to_regclass('public.bb_performance_spans') IS NULL THEN
  RAISE EXCEPTION 'canonical performance tables are required';
 END IF;
 FOREACH role_name IN ARRAY ARRAY['bb1361_formal_n1_author_v1','bb1361_formal_n1_review_v1','bb1361_formal_n2_author_v1','bb1361_formal_n2_review_v1'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit) THEN
   RAISE EXCEPTION 'managed worker role missing or privilege identity changed: %',role_name;
  END IF;
 END LOOP;
END $guard$;
GRANT SELECT ON public.bb_performance_sessions, public.bb_performance_spans
 TO bb1361_formal_n1_author_v1, bb1361_formal_n1_review_v1, bb1361_formal_n2_author_v1, bb1361_formal_n2_review_v1;
GRANT INSERT(session_id,owner_user_id,project_id,run_id,job_id,trace_id,run_execution_id,task_kind,service_role,worker_instance_id,release_sha,started_at,ended_at,last_flush_at,closed,generated,acknowledged,dropped,invalid_attributes,flush_errors,last_sequence,complete),
 UPDATE(ended_at,last_flush_at,closed,generated,acknowledged,dropped,invalid_attributes,flush_errors,last_sequence,complete)
 ON public.bb_performance_sessions
 TO bb1361_formal_n1_author_v1, bb1361_formal_n1_review_v1, bb1361_formal_n2_author_v1, bb1361_formal_n2_review_v1;
GRANT INSERT(span_id,owner_user_id,run_id,session_id,run_execution_id,trace_id,job_id,parent_span_id,stage,step_key,step_version,status,started_at,ended_at,duration_ms,last_activity_at,clock_source,attributes,span_links,sequence),
 UPDATE(status,ended_at,duration_ms,last_activity_at,attributes,span_links,sequence)
 ON public.bb_performance_spans
 TO bb1361_formal_n1_author_v1, bb1361_formal_n1_review_v1, bb1361_formal_n2_author_v1, bb1361_formal_n2_review_v1;
COMMIT;
