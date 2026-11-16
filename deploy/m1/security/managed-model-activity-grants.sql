-- Full develop worker prerequisite (0182), separate from the 0189 audit fix.
-- Release owner: apply once per approved restricted consumer role after 0182,
-- using psql -v ON_ERROR_STOP=1 -v runtime_role=<reviewed role> -f <this file>.
-- No role creation, membership, default grants or audit-table write privileges.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
GRANT SELECT, DELETE ON public.bb_run_model_activity TO :"runtime_role";
GRANT INSERT(request_id,owner_user_id,run_id,job_id,lease_token,state),
      UPDATE(state,updated_at)
 ON public.bb_run_model_activity TO :"runtime_role";
COMMIT;
