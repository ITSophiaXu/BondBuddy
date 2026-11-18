-- Apply after 0193, to the existing reviewed consumer role. Save its ACL first.
-- psql -v ON_ERROR_STOP=1 -v runtime_role=<reviewed role> -f <this file>
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
GRANT SELECT, INSERT ON public.bb_model_workspace_evidence TO :"runtime_role";
-- The 0192 reservation trigger runs under the same consumer identity.
GRANT INSERT(owner_user_id,scope_quote_id,reservation_id) ON public.bb_authoring_scope_reservations TO :"runtime_role";
COMMIT;
