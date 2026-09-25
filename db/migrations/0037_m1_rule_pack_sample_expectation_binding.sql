-- 0036 compared a production evidence outcome with `expected_outcome` on a
-- SampleCase, but the domain SampleCase schema has no such field. That made
-- every otherwise-valid release impossible to attest. Bind each case to its
-- rule's polarity-matched example instead; the outcome must match the exact
-- evidence_ref in the immutable pack snapshot.
DO $migration$
DECLARE
  definition text;
  old_clause text := $old$AND s.expected_outcome=c->>'expected_outcome' AND c->>'result'='passed'$old$;
  old_source_clause text := $source$AND s.pack_hash=NEW.content_hash AND s.source_id=src->>'source_id'$source$;
  new_source_clause text := $source_bound$AND s.pack_hash=NEW.content_hash AND s.source_id=src->>'source_id'
          AND s.verifier_user_id=src->>'verified_by'$source_bound$;
  new_clause text := $new$AND c->>'result'='passed'
        AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(NEW.pack_snapshot->'rules') AS r
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE c->>'polarity'
                WHEN 'positive' THEN COALESCE(r->'positive_examples','[]'::jsonb)
                WHEN 'negative' THEN COALESCE(r->'negative_examples','[]'::jsonb)
                WHEN 'boundary' THEN COALESCE(r->'boundary_examples','[]'::jsonb)
                ELSE '[]'::jsonb
              END
            ) AS example
            WHERE example->>'evidence_ref'=c->>'evidence_ref'
              AND example->>'expected_outcome'=s.expected_outcome
          )
          AND (SELECT count(*)
            FROM jsonb_array_elements(NEW.pack_snapshot->'rules') AS r
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE c->>'polarity'
                WHEN 'positive' THEN COALESCE(r->'positive_examples','[]'::jsonb)
                WHEN 'negative' THEN COALESCE(r->'negative_examples','[]'::jsonb)
                WHEN 'boundary' THEN COALESCE(r->'boundary_examples','[]'::jsonb)
                ELSE '[]'::jsonb
              END
            ) AS example
            WHERE example->>'evidence_ref'=c->>'evidence_ref')=1$new$;
BEGIN
  SELECT pg_get_functiondef('bb_rule_pack_production_event_guard()'::regprocedure)
    INTO definition;
  IF position(old_clause IN definition)=0 THEN
    RAISE EXCEPTION '0036 sample evidence guard clause not found; refusing unsafe migration';
  END IF;
  IF length(definition)-length(replace(definition, old_clause, '')) <> length(old_clause) THEN
    RAISE EXCEPTION '0036 sample evidence guard clause is ambiguous; refusing unsafe migration';
  END IF;
  IF position(old_source_clause IN definition)=0 THEN
    RAISE EXCEPTION '0036 source verifier guard clause not found; refusing unsafe migration';
  END IF;
  IF length(definition)-length(replace(definition, old_source_clause, '')) <> length(old_source_clause) THEN
    RAISE EXCEPTION '0036 source verifier guard clause is ambiguous; refusing unsafe migration';
  END IF;
  definition := replace(definition, old_clause, new_clause);
  definition := replace(definition, old_source_clause, new_source_clause);
  EXECUTE definition;
END
$migration$;

COMMENT ON FUNCTION bb_rule_pack_production_event_guard() IS
  'Fail-closed production registry guard. Source verification users bind to active database grant holders; each sample outcome binds uniquely to its polarity-matched rule example evidence_ref and expected_outcome. 0037 corrects absent SampleCase.expected_outcome in 0036.';
