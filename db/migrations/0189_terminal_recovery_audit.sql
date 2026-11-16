-- #1462: terminal bookkeeping belongs to this trigger, not to the worker's
-- direct audit-table privileges. Keep the existing function owner and append-only
-- table; pin every object and deny reuse as a trigger on caller-owned tables.
CREATE OR REPLACE FUNCTION public.bb_record_error_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'bb_jobs'
    OR TG_OP <> 'UPDATE' OR TG_LEVEL <> 'ROW' THEN
   RAISE EXCEPTION 'Recovery audit requires the job transition trigger' USING ERRCODE='42501';
 END IF;
 IF NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected')
    AND OLD.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') THEN
   INSERT INTO public.bb_error_recovery_events(id,error_id,job_id,outcome)
   SELECT md5(e.id || ':' || NEW.id || ':' || NEW.state),e.id,NEW.id,
     CASE WHEN NEW.state IN ('succeeded','test_completed') THEN 'recovered'
          WHEN NEW.state='cancelled' THEN 'user_cancelled'
          ELSE 'retried_failed' END
   FROM public.bb_observability_errors e
   WHERE e.job_id=NEW.id AND e.recovery_status='retry_scheduled'
   ON CONFLICT (error_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
-- Existing triggers do not need callers to have EXECUTE on their function.
REVOKE ALL ON FUNCTION public.bb_record_error_recovery() FROM PUBLIC;
