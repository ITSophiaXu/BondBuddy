-- Restricted consumers may coordinate call admission without gaining UPDATE,
-- DELETE or TRUNCATE on the append-only evidence gate. Keep the existing table
-- lock modes: old and new processes therefore serialize during a rolling update.
CREATE FUNCTION public.bb_lock_evidence_gate(p_exclusive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
 IF p_exclusive IS NULL THEN
  RAISE EXCEPTION 'Evidence gate lock mode is required' USING ERRCODE='22004';
 ELSIF p_exclusive THEN
  LOCK TABLE public.bb_evidence_gate_events IN SHARE ROW EXCLUSIVE MODE;
 ELSE
  LOCK TABLE public.bb_evidence_gate_events IN SHARE MODE;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.bb_lock_evidence_gate(boolean) FROM PUBLIC;
COMMENT ON FUNCTION public.bb_lock_evidence_gate(boolean) IS
 'Only locks the evidence gate until transaction end; never changes gate state. Grant EXECUTE only to reviewed consumers.';
