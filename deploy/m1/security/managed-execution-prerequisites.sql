-- Apply after 0190, once for each reviewed authoring/review consumer. Preserve
-- the captured base ACL; this is the explicit delta, not a blanket role grant.
-- psql -v ON_ERROR_STOP=1 -v runtime_role=<reviewed role> -f <this file>
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
GRANT USAGE ON SEQUENCE public.bb_model_capacity_order TO :"runtime_role";
GRANT UPDATE(state,finalized_at)
 ON public.bb_credit_reservations TO :"runtime_role";
GRANT SELECT ON public.bb_project_file_check_attempts TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.bb_lock_evidence_gate(boolean) TO :"runtime_role";
-- Full-source workers also contain the 0182 activity writer.
GRANT SELECT, DELETE ON public.bb_run_model_activity TO :"runtime_role";
GRANT INSERT(request_id,owner_user_id,run_id,job_id,lease_token,state),
      UPDATE(state,updated_at)
 ON public.bb_run_model_activity TO :"runtime_role";
COMMIT;
