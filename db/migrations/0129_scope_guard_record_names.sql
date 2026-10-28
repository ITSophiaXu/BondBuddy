-- PostgreSQL trigger records OLD/NEW must not double as SQL aliases.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('bb_scope_quotation_guard()'::regprocedure) INTO definition;
 IF strpos(definition,'FROM bb_scope_quotations old WHERE old.')=0 THEN RAISE EXCEPTION 'Unexpected quotation revision guard'; END IF;
 definition:=replace(definition,'FROM bb_scope_quotations old WHERE old.','FROM bb_scope_quotations prior_quote WHERE prior_quote.');
 definition:=replace(definition,'old.','prior_quote.');
 EXECUTE definition;
END $$;
