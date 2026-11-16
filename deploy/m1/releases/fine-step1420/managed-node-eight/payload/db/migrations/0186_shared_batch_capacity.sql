-- Scheduling capacity belongs to the common execution pool, not frozen inputs.
-- Keep exact batch/child identity, input hashes, membership and all mutex checks.
-- Historical NULL/2 policies remain in the audit rows without imposing 1/2 slots.
DO $$ DECLARE definition text; workpaper_cap text; other_cap text; BEGIN
 SELECT pg_get_functiondef('bb_batch_child_identity(text,text,integer,text,text)'::regprocedure) INTO definition;
 workpaper_cap:='COALESCE((b.progressive_plan->>''max_parallel'')::smallint,b.max_parallel,1)::text';
 other_cap:='COALESCE(b.max_parallel,1)::text';
 IF (length(definition)-length(replace(definition,workpaper_cap,'')))/length(workpaper_cap)<>1
  OR (length(definition)-length(replace(definition,other_cap,'')))/length(other_cap)<>2 THEN
  RAISE EXCEPTION 'Unexpected frozen batch identity capacity';
 END IF;
 definition:=replace(replace(definition,workpaper_cap,'''4''::text'),other_cap,'''4''::text');
 EXECUTE definition;
END $$;
