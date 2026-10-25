CREATE TABLE bb_project_qa_drafts (
 owner_user_id text NOT NULL,project_id text PRIMARY KEY,revision integer NOT NULL,draft jsonb NOT NULL,
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_project_qa_runs (
 run_id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,sequence integer NOT NULL,
 operation text NOT NULL CHECK(operation IN ('prepare','answer')),manifest jsonb NOT NULL,input_hash char(64) NOT NULL,
 result jsonb,result_hash char(64),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,run_id),UNIQUE(project_id,sequence),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE FUNCTION bb_project_qa_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.run_id,NEW.owner_user_id,NEW.project_id,NEW.sequence,NEW.operation,NEW.manifest,NEW.input_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_user_id,OLD.project_id,OLD.sequence,OLD.operation,OLD.manifest,OLD.input_hash,OLD.created_at)
 OR (OLD.result IS NOT NULL AND ROW(NEW.result,NEW.result_hash) IS DISTINCT FROM ROW(OLD.result,OLD.result_hash))
 THEN RAISE EXCEPTION 'Q&A snapshot is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bb_project_qa_run_immutable BEFORE UPDATE ON bb_project_qa_runs FOR EACH ROW EXECUTE FUNCTION bb_project_qa_run_guard();
CREATE TRIGGER bb_project_qa_run_keep BEFORE DELETE ON bb_project_qa_runs FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_project_qa_answers (
 owner_user_id text NOT NULL,run_id text NOT NULL,question_id text NOT NULL,answer jsonb NOT NULL,sha256 char(64) NOT NULL,
 PRIMARY KEY(run_id,question_id),FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_project_qa_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_project_qa_answer_immutable BEFORE UPDATE OR DELETE ON bb_project_qa_answers FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_project_qa_quotes (
 id text PRIMARY KEY,owner_user_id text NOT NULL,run_id text NOT NULL UNIQUE,input_hash char(64) NOT NULL,
 question_count integer NOT NULL CHECK(question_count BETWEEN 1 AND 200),unit_points integer NOT NULL CHECK(unit_points=60),
 points bigint NOT NULL CHECK(points=question_count*unit_points),price_version text NOT NULL CHECK(price_version='project-qa-question-60-v1'),
 UNIQUE(owner_user_id,id),FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_project_qa_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_project_qa_quote_immutable BEFORE UPDATE OR DELETE ON bb_project_qa_quotes FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
DO $$ DECLARE definition text; marker text := 'THEN RAISE EXCEPTION ''Owned immutable quote required'''; BEGIN
 SELECT pg_get_functiondef('bb_credit_reservation_quote_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected quote guard'; END IF;
 EXECUTE replace(definition,marker,$guard$AND NOT EXISTS(
 SELECT 1 FROM bb_project_qa_quotes q JOIN bb_project_qa_runs i ON i.run_id=q.run_id AND i.owner_user_id=q.owner_user_id
 WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.run_id=NEW.run_id AND q.points=NEW.points
 AND i.operation='answer' AND i.input_hash=q.input_hash AND jsonb_array_length(i.manifest->'questions')=q.question_count AND NEW.billing_policy='on_delivery')
 THEN RAISE EXCEPTION 'Owned immutable quote required'$guard$); END $$;
CREATE FUNCTION bb_project_qa_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_project_qa_runs i
 JOIN bb_artifact_versions v ON v.owner_user_id=i.owner_user_id AND v.run_id=i.run_id
 JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id AND e.artifact_id=v.id AND e.artifact_version=v.version
 WHERE i.run_id=r.id AND i.owner_user_id=r.owner_user_id AND i.operation='answer'
 AND jsonb_array_length(i.result->'answers')=jsonb_array_length(i.manifest->'questions')
 AND i.result#>>'{document,sha256}'=v.sha256 AND v.id=r.artifact_id AND v.version=r.artifact_version
 AND v.delivery_status='available' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
 AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256);
$$;
DO $$ DECLARE definition text; marker text := 'IF NEW.state=''succeeded'' AND EXISTS(SELECT 1 FROM bb_integrity_runs'; BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected credit finalizer'; END IF;
 EXECUTE replace(definition,marker,$guard$IF NEW.state='succeeded' AND EXISTS(SELECT 1 FROM bb_project_qa_runs WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id AND operation='answer') THEN
 IF NOT bb_project_qa_delivery_ready(NEW) THEN RAISE EXCEPTION 'Delivered Q&A Word required' USING ERRCODE='23514'; END IF;
 ELSIF NEW.state='succeeded' AND EXISTS(SELECT 1 FROM bb_integrity_runs$guard$); END $$;

-- Private project content is never ingested automatically. Only explicit public-source submissions.
CREATE TABLE bb_qa_cases (
 id text PRIMARY KEY,owner_user_id text NOT NULL REFERENCES bb_users(id),request_id text NOT NULL,content jsonb NOT NULL,sha256 char(64) NOT NULL,
 search_terms text[] NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','withdrawn')),
 revision integer NOT NULL DEFAULT 1,review_note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id)
);
CREATE INDEX bb_qa_case_search ON bb_qa_cases USING gin(search_terms);
CREATE TABLE bb_qa_case_reviewers (user_id text PRIMARY KEY REFERENCES bb_users(id),actor text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE bb_qa_case_reviews (id text PRIMARY KEY,case_id text NOT NULL REFERENCES bb_qa_cases(id),reviewer_user_id text NOT NULL REFERENCES bb_users(id),revision integer NOT NULL,status text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(case_id,revision));
CREATE TRIGGER bb_qa_review_immutable BEFORE UPDATE OR DELETE ON bb_qa_case_reviews FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE FUNCTION bb_qa_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.owner_user_id,NEW.request_id,NEW.content,NEW.sha256,NEW.search_terms,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.request_id,OLD.content,OLD.sha256,OLD.search_terms,OLD.created_at)
 THEN RAISE EXCEPTION 'Public case content is immutable; submit a new version' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bb_qa_case_immutable BEFORE UPDATE ON bb_qa_cases FOR EACH ROW EXECUTE FUNCTION bb_qa_case_guard();
