-- Restricted consumer prerequisite for model-call-budget admission and the
-- existing bb_credit_finalize_run / bb_m4_credit_finalize_run triggers.
-- Apply only to the reviewed pool consumer, after saving its current ACL:
-- psql -v ON_ERROR_STOP=1 -v runtime_role=<reviewed role> -f <this file>
-- No ownership, membership, default grants, audit writes or table-wide UPDATE.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
GRANT USAGE ON SEQUENCE public.bb_model_capacity_order TO :"runtime_role";
GRANT UPDATE(state,finalized_at)
 ON public.bb_credit_reservations TO :"runtime_role";
COMMIT;
