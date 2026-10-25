-- Immutable per-round integrity scope, observations, evidence and pricing.
CREATE TABLE bb_integrity_drafts (
 owner_user_id text NOT NULL,project_id text PRIMARY KEY,revision integer NOT NULL DEFAULT 0,draft jsonb NOT NULL,
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_integrity_runs (
 run_id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,round_id text NOT NULL,
 sequence integer NOT NULL,operation text NOT NULL CHECK(operation IN ('check','export')),
 manifest jsonb NOT NULL,input_hash char(64) NOT NULL,result jsonb,result_hash char(64),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,run_id),UNIQUE(project_id,sequence),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,round_id) REFERENCES bb_integrity_runs(owner_user_id,run_id)
);
CREATE FUNCTION bb_integrity_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.owner_user_id,NEW.project_id,NEW.round_id,NEW.sequence,NEW.operation,NEW.manifest,NEW.input_hash,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_user_id,OLD.project_id,OLD.round_id,OLD.sequence,OLD.operation,OLD.manifest,OLD.input_hash,OLD.created_at)
 OR (OLD.result IS NOT NULL AND ROW(NEW.result,NEW.result_hash) IS DISTINCT FROM ROW(OLD.result,OLD.result_hash))
 THEN RAISE EXCEPTION 'Integrity snapshot is immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER bb_integrity_run_immutable BEFORE UPDATE ON bb_integrity_runs FOR EACH ROW EXECUTE FUNCTION bb_integrity_run_guard();
CREATE TRIGGER bb_integrity_run_keep BEFORE DELETE ON bb_integrity_runs FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_integrity_evidence (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,round_id text NOT NULL,
 request_id text NOT NULL,request_hash char(64) NOT NULL,record jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id),FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,round_id) REFERENCES bb_integrity_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_integrity_evidence_immutable BEFORE UPDATE OR DELETE ON bb_integrity_evidence FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_integrity_quotes (
 id text PRIMARY KEY,owner_user_id text NOT NULL,run_id text NOT NULL UNIQUE,input_hash char(64) NOT NULL,
 points bigint NOT NULL CHECK(points=5000),price_version text NOT NULL CHECK(price_version='integrity-round-5000-v1'),
 UNIQUE(owner_user_id,id),FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_integrity_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_integrity_quotes_immutable BEFORE UPDATE OR DELETE ON bb_integrity_quotes FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
DO $$ DECLARE definition text; marker text := 'THEN RAISE EXCEPTION ''Owned immutable quote required''';
BEGIN
 SELECT pg_get_functiondef('bb_credit_reservation_quote_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected quote guard'; END IF;
 EXECUTE replace(definition,marker,$guard$AND NOT EXISTS(
  SELECT 1 FROM bb_integrity_quotes q JOIN bb_integrity_runs i ON i.run_id=q.run_id AND i.owner_user_id=q.owner_user_id
  WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.run_id=NEW.run_id AND q.points=NEW.points
  AND i.operation='check' AND i.input_hash=q.input_hash AND NEW.billing_policy='on_delivery')
 THEN RAISE EXCEPTION 'Owned immutable quote required'$guard$);
END $$;
-- The single workpaper must be delivered and a real search recorded before settling a round.
CREATE FUNCTION bb_integrity_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_integrity_runs i
 JOIN bb_artifact_versions v ON v.owner_user_id=i.owner_user_id AND v.run_id=i.run_id
 JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id AND e.artifact_id=v.id AND e.artifact_version=v.version
 WHERE i.run_id=r.id AND i.owner_user_id=r.owner_user_id AND i.operation='check'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.result->'records') rec WHERE rec->>'search_performed'='true')
 AND v.id=r.artifact_id AND v.version=r.artifact_version AND v.delivery_status='available'
 AND e.delivery_status='available' AND e.delivery_code='readback_verified' AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256);
$$;
DO $$ DECLARE definition text; marker text := 'IF NEW.state=''succeeded'' AND NEW.task_kind=''review'' THEN';
BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected credit finalizer'; END IF;
 EXECUTE replace(definition,marker,$guard$IF NEW.state='succeeded' AND EXISTS(SELECT 1 FROM bb_integrity_runs WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id AND operation='check') THEN
   IF NOT bb_integrity_delivery_ready(NEW) THEN RAISE EXCEPTION 'Delivered integrity workpaper and actual search required' USING ERRCODE='23514'; END IF;
 ELSIF NEW.state='succeeded' AND NEW.task_kind='review' THEN$guard$);
END $$;


CREATE TABLE bb_integrity_observations (
 owner_user_id text NOT NULL,run_id text NOT NULL,subject_id text NOT NULL,site_id text NOT NULL,record jsonb NOT NULL,sha256 char(64) NOT NULL,
 PRIMARY KEY(run_id,subject_id,site_id),FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_integrity_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_integrity_observations_immutable BEFORE UPDATE OR DELETE ON bb_integrity_observations FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
