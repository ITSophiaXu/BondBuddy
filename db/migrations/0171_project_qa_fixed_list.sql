-- New question-list tasks identify and answer questions in one paid run.
-- Historical per-question and reviewed-scope quotes remain readable.
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_quotes_question_count_check;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_quotes_question_count_check CHECK(question_count BETWEEN 0 AND 200);
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_price_terms;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_price_terms CHECK(
 (price_version='project-qa-question-60-v1' AND unit_points=60 AND points=question_count*unit_points) OR
 (price_version='project-qa-list-12000-v1' AND question_count=0 AND unit_points=12000 AND points=12000 AND scope_quote_id IS NULL) OR
 (bb_is_outcome_price_version(price_version) AND points>=0 AND unit_points>=0 AND (points=0 OR scope_quote_id IS NOT NULL)));

CREATE OR REPLACE FUNCTION bb_project_qa_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_project_qa_runs i
 JOIN bb_artifact_versions v ON v.owner_user_id=i.owner_user_id AND v.run_id=i.run_id
 JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id AND e.artifact_id=v.id AND e.artifact_version=v.version
 WHERE i.run_id=r.id AND i.owner_user_id=r.owner_user_id AND i.operation='answer'
 AND jsonb_array_length(i.result->'questions') BETWEEN 1 AND 200
 AND jsonb_array_length(i.result->'answers')=jsonb_array_length(i.result->'questions')
 AND (i.manifest->>'price_version'='project-qa-list-12000-v1' OR i.result->'questions'=i.manifest->'questions')
 AND i.result#>>'{document,sha256}'=v.sha256 AND v.id=r.artifact_id AND v.version=r.artifact_version
 AND v.delivery_status='available' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
 AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256);
$$;
