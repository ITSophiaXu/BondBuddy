-- Avoid a PL/pgSQL record variable shadowing the artifact query alias.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 definition:=replace(definition,'a record;','allocation record;');
 definition:=replace(definition,'FOR a IN SELECT','FOR allocation IN SELECT');
 definition:=replace(definition,'a.lot_id','allocation.lot_id');
 definition:=replace(definition,'a.points','allocation.points');
 EXECUTE definition;
END $$;
