-- Submitted/blocked requests are not delivered searches. Keep authentic legacy
-- web-search actions readable, including a real search returning zero sources.
CREATE FUNCTION bb_integrity_query_evidence_ready(owner_id text, target_run text, records jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(
  SELECT 1 FROM jsonb_array_elements(coalesce(records,'[]'::jsonb)) rec
  WHERE rec->>'search_performed'='true' AND length(btrim(coalesce(rec->>'query','')))>0
   AND rec->>'status' IN ('public_matches','no_public_results','needs_manual')
   AND (
    (jsonb_typeof(rec->'browser')='object'
     AND rec->'browser'->>'outcome' IN ('results','no_results')
     AND rec->>'status' IN ('public_matches','no_public_results')
     AND (rec->'browser'->'diagnostic' IS NULL OR rec->'browser'->'diagnostic'->>'code' IN ('results','no_results'))
     AND EXISTS(SELECT 1 FROM bb_integrity_browser_batches b
      JOIN bb_integrity_browser_captures c ON c.owner_user_id=b.owner_user_id AND c.run_id=b.run_id AND c.subject_id=b.subject_id AND c.site_id=b.site_id
      WHERE b.owner_user_id=owner_id AND b.run_id=target_run AND b.subject_id=rec->>'subject_id' AND b.site_id=rec->>'site_id'
       AND b.payload->>'search_performed'='true' AND b.payload->>'query'=rec->>'query' AND b.payload->>'outcome'=rec->'browser'->>'outcome'
       AND c.metadata->>'kind'='result' AND rec->'browser'->'captures' @> jsonb_build_array(c.metadata)
       AND b.payload->'captures' @> jsonb_build_array(jsonb_build_object('metadata',c.metadata))))
    OR
    (NOT rec ? 'browser' AND EXISTS(
     SELECT 1 FROM bb_model_web_search_evidence evidence
     CROSS JOIN LATERAL jsonb_array_elements(evidence.events) event
     CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(event->'item'->'action'->'queries')='array' THEN event->'item'->'action'->'queries' ELSE '[]'::jsonb END
      || CASE WHEN jsonb_typeof(event->'item'->'action'->'query')='string' THEN jsonb_build_array(event->'item'->'action'->'query') ELSE '[]'::jsonb END) query
     WHERE evidence.owner_user_id=owner_id AND evidence.run_id=target_run
      AND event->'item'->>'type'='web_search' AND length(event->'item'->>'id')>0
      AND event->>'observed_at' ~ '^\d{4}-\d{2}-\d{2}T'
      AND (event->'item'->>'status' IS NULL OR event->'item'->>'status'='completed')
      AND (event->'item'->'action'->>'type' IS NULL OR event->'item'->'action'->>'type'='search')
      AND query #>> '{}' = ANY(regexp_split_to_array(rec->>'query',E'\n'))
    ))
   )
 );
$$;

CREATE OR REPLACE FUNCTION bb_integrity_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_integrity_runs i
 JOIN bb_artifact_versions v ON v.owner_user_id=i.owner_user_id AND v.run_id=i.run_id
 JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id AND e.artifact_id=v.id AND e.artifact_version=v.version
 WHERE i.run_id=r.id AND i.owner_user_id=r.owner_user_id AND i.operation='check'
 AND bb_integrity_query_evidence_ready(i.owner_user_id,i.run_id,i.result->'records')
 AND v.id=r.artifact_id AND v.version=r.artifact_version AND v.delivery_status='available'
 AND e.delivery_status='available' AND e.delivery_code='readback_verified' AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256);
$$;
