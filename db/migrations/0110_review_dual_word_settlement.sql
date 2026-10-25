-- New review editions settle only after the revision, clean copy and report are
-- privately delivered. Old immutable inputs retain their report-only condition.
CREATE FUNCTION bb_review_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE correction boolean; pair jsonb;
BEGIN
 SELECT manifest #>> '{review,file_delivery,version}' = 'review-correction-v2' INTO correction
 FROM bb_input_revisions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND revision=r.input_revision;
 IF correction IS DISTINCT FROM true THEN
   RETURN EXISTS(SELECT 1 FROM bb_review_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
     WHERE a.owner_user_id=r.owner_user_id AND a.run_id=r.id AND a.project_id=r.project_id AND a.kind='report'
       AND v.owner_user_id=r.owner_user_id AND v.run_id=r.id AND v.id=r.artifact_id AND v.version=r.artifact_version
       AND v.delivery_status='available' AND v.quality_status='passed');
 END IF;
 SELECT checkpoint #> '{stages,word_delivery_pair}' INTO pair FROM bb_jobs WHERE owner_user_id=r.owner_user_id AND run_id=r.id;
 IF pair->>'revision_artifact_id' IS NULL OR pair->>'clean_artifact_id' IS NULL OR r.artifact_id IS DISTINCT FROM pair->>'revision_artifact_id' THEN RETURN false; END IF;
 RETURN (SELECT count(DISTINCT a.kind)=3 FROM bb_review_artifacts a
   JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
   JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id
     AND e.artifact_id=v.id AND e.artifact_version=v.version
   WHERE a.owner_user_id=r.owner_user_id AND a.project_id=r.project_id AND a.run_id=r.id
     AND v.delivery_status='available' AND v.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
     AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256
     AND (a.kind='report' OR (a.kind='revision' AND v.id=r.artifact_id AND v.version=r.artifact_version)
       OR (a.kind='clean' AND v.id=pair->>'clean_artifact_id')));
END; $$;

DO $$ DECLARE definition text; before_guard text := $guard$IF NOT EXISTS(SELECT 1 FROM bb_review_artifacts report JOIN bb_artifact_versions v ON v.id=report.artifact_id AND v.version=report.artifact_version
      WHERE report.owner_user_id=NEW.owner_user_id AND report.run_id=NEW.id AND report.project_id=NEW.project_id AND report.kind='report'
      AND v.owner_user_id=NEW.owner_user_id AND v.run_id=NEW.id AND v.id=NEW.artifact_id AND v.version=NEW.artifact_version AND v.delivery_status='available' AND v.quality_status='passed')$guard$;
BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 definition:=replace(definition,chr(13),'');
 before_guard:=replace(before_guard,chr(13),'');
 IF strpos(definition,before_guard)=0 THEN RAISE EXCEPTION 'Unexpected review credit finalizer definition'; END IF;
 EXECUTE replace(definition,before_guard,'IF NOT bb_review_delivery_ready(NEW)');
END $$;
