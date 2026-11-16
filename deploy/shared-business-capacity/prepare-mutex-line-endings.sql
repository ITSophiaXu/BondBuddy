-- Exact compatibility prelude for the observed function; run in the same
-- transaction immediately before unchanged migrations 0180 and 0186.
-- Only CRLF encoding changes; CREATE OR REPLACE preserves owner and ACL.
DO $$ DECLARE definition text; normalized text; BEGIN
 SELECT pg_get_functiondef('public.bb_m3_project_run_mutex()'::regprocedure) INTO definition;
 IF encode(sha256(convert_to(rtrim(definition,chr(10)),'UTF8')),'hex')<>'0bb3fe58b2138a1ef1e7b874b72797bf7faf2ab2928d37177ee69154096eed73' THEN
  RAISE EXCEPTION 'Batch mutex preimage changed';
 END IF;
 normalized:=replace(definition,chr(13)||chr(10),chr(10));
 IF normalized=definition OR strpos(normalized,chr(13))<>0
  OR encode(sha256(convert_to(rtrim(normalized,chr(10)),'UTF8')),'hex')<>'a9b36cb5a838d3859dc8f71184badf7d4f86e271277b6c6d9c8c7c92cea77794' THEN
  RAISE EXCEPTION 'Batch mutex line encoding changed';
 END IF;
 EXECUTE normalized;
END $$;
