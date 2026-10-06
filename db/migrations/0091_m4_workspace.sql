-- M4 uses new subtypes and immutable inputs; legacy generation/QA is unchanged.
ALTER TABLE bb_projects ADD COLUMN execution_scope_project_id text;
ALTER TABLE bb_projects ADD FOREIGN KEY(owner_user_id,execution_scope_project_id) REFERENCES bb_projects(owner_user_id,id);
CREATE TABLE bb_m4_topics (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL UNIQUE, source_project_id text,
 name text NOT NULL, creation_request_id text NOT NULL, request_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id), UNIQUE(owner_user_id,creation_request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,source_project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_m4_topic_materials (
 owner_user_id text NOT NULL, topic_id text NOT NULL, source_project_id text NOT NULL,
 material_id text NOT NULL, material_version integer NOT NULL, sha256 char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(topic_id,material_id,material_version),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id),
 FOREIGN KEY(owner_user_id,material_id,material_version) REFERENCES bb_material_versions(owner_user_id,id,version)
);
CREATE TABLE bb_m4_templates (
 id text NOT NULL, version integer NOT NULL, owner_user_id text NOT NULL, document_type text NOT NULL CHECK(document_type IN ('init','private_summary')),
 name text NOT NULL, broker text NOT NULL, material jsonb NOT NULL, sha256 char(64) NOT NULL,
 creation_request_id text NOT NULL, request_hash char(64) NOT NULL, market text NOT NULL CHECK(market IN ('sse','szse')),
 created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
 PRIMARY KEY(id,version), UNIQUE(owner_user_id,id,version), UNIQUE(owner_user_id,creation_request_id)
);
CREATE TABLE bb_m4_drafts (
 owner_user_id text NOT NULL, topic_id text NOT NULL, document_type text NOT NULL CHECK(document_type IN ('init','private_summary')),
 version integer NOT NULL, input jsonb NOT NULL, sha256 char(64) NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(topic_id,document_type), FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id)
);
CREATE TABLE bb_m4_views (
 owner_user_id text NOT NULL, topic_id text NOT NULL PRIMARY KEY, version integer NOT NULL, view jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id)
);
CREATE TABLE bb_m4_messages (
 id text PRIMARY KEY, owner_user_id text NOT NULL, topic_id text NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')),
 version integer NOT NULL DEFAULT 1, content text NOT NULL, context jsonb NOT NULL, submission_request_id text, request_hash char(64),
 reply_to text, run_id text, reply_status text NOT NULL CHECK(reply_status IN ('queued','running','completed','failed','unknown')),
 reply jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id), UNIQUE(owner_user_id,submission_request_id), UNIQUE(reply_to),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id),
 FOREIGN KEY(owner_user_id,reply_to) REFERENCES bb_m4_messages(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TABLE bb_m4_executions (
 run_id text PRIMARY KEY, owner_user_id text NOT NULL, topic_id text NOT NULL, manifest jsonb NOT NULL, input_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id)
);
CREATE TRIGGER bb_m4_execution_immutable BEFORE UPDATE OR DELETE ON bb_m4_executions FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_m4_artifacts (
 owner_user_id text NOT NULL, topic_id text NOT NULL, run_id text NOT NULL, artifact_id text NOT NULL, artifact_version integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('document','preparation_note','qa_text')), filename text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
 document_type text CHECK(document_type IN ('init','private_summary')), base_artifact jsonb, input_hash char(64) NOT NULL,
 body_content text, preview_content text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(artifact_id,artifact_version), UNIQUE(run_id,kind),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,artifact_id,artifact_version) REFERENCES bb_artifact_versions(owner_user_id,id,version)
);
CREATE TRIGGER bb_m4_artifact_immutable BEFORE UPDATE OR DELETE ON bb_m4_artifacts FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
-- Published M4 coefficients/rates and estimation budgets are separate from M2 fixed prices.
CREATE TABLE bb_m4_billing_configs (
 id text PRIMARY KEY, config jsonb NOT NULL, effective_at timestamptz NOT NULL UNIQUE, actor text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bb_m4_billing_configs_immutable BEFORE UPDATE OR DELETE ON bb_m4_billing_configs FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TABLE bb_m4_quotes (
 id text PRIMARY KEY, owner_user_id text NOT NULL, topic_id text NOT NULL, intent_hash char(64) NOT NULL,
 task_type text NOT NULL, config_id text REFERENCES bb_m4_billing_configs, reserve_points bigint NOT NULL CHECK(reserve_points>=0),
 multiplier numeric NOT NULL CHECK(multiplier>=0), snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id), UNIQUE(owner_user_id,id)
);
CREATE TRIGGER bb_m4_quotes_immutable BEFORE UPDATE OR DELETE ON bb_m4_quotes FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
-- M4 reservations share the actual wallet and allocation ledger, but have different settlement semantics.
ALTER TABLE bb_credit_reservations DROP CONSTRAINT bb_credit_reservations_owner_user_id_quote_id_fkey;
ALTER TABLE bb_credit_reservations ADD COLUMN charged_points bigint CHECK(charged_points>=0 AND charged_points<=points);
ALTER TABLE bb_runs DROP CONSTRAINT bb_runs_billing_mode_check;
ALTER TABLE bb_runs ADD CONSTRAINT bb_runs_billing_mode_check CHECK(billing_mode IN ('platform_trial','non_billable_test','fixed_credits','metered_credits'));
ALTER TABLE bb_runs DROP CONSTRAINT bb_paid_run_reservation;
ALTER TABLE bb_runs ADD CONSTRAINT bb_paid_run_reservation CHECK((billing_mode IN ('fixed_credits','metered_credits'))=(reservation_id IS NOT NULL));
CREATE FUNCTION bb_credit_reservation_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_credit_quotes WHERE owner_user_id=NEW.owner_user_id AND id=NEW.quote_id)
 AND NOT EXISTS(SELECT 1 FROM bb_m4_quotes WHERE owner_user_id=NEW.owner_user_id AND id=NEW.quote_id AND reserve_points=NEW.points)
 THEN RAISE EXCEPTION 'Owned immutable quote required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_credit_reservation_quote BEFORE INSERT ON bb_credit_reservations FOR EACH ROW EXECUTE FUNCTION bb_credit_reservation_quote_guard();
CREATE TABLE bb_m4_metering (
 run_id text PRIMARY KEY, owner_user_id text NOT NULL, status text NOT NULL CHECK(status IN ('verified','waived')),
 actual_points bigint NOT NULL CHECK(actual_points>=0), charged_points bigint NOT NULL CHECK(charged_points>=0), evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_m4_metering_immutable BEFORE UPDATE OR DELETE ON bb_m4_metering FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE FUNCTION bb_m4_credit_finalize_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations%ROWTYPE; a record; charged bigint; remaining_charge bigint; take bigint; l bb_credit_lots%ROWTYPE; compensation text;
BEGIN
 IF NEW.billing_mode<>'metered_credits' OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW; END IF;
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
 SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND owner_user_id=NEW.owner_user_id AND run_id=NEW.id FOR UPDATE;
 IF r.state<>'held' THEN RAISE EXCEPTION 'M4 reservation already finalized' USING ERRCODE='23514'; END IF;
 charged:=0;
 IF NEW.state='succeeded' THEN
   SELECT charged_points INTO STRICT charged FROM bb_m4_metering WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id;
   IF charged>r.points THEN RAISE EXCEPTION 'M4 charge exceeds reservation' USING ERRCODE='23514'; END IF;
   IF NEW.task_kind='generation' THEN
     IF (SELECT count(*) FROM bb_m4_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
       JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id
       WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.kind IN ('document','preparation_note')
       AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id AND v.delivery_status='available'
       AND e.delivery_code='readback_verified' AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256)<>2
     THEN RAISE EXCEPTION 'M4 document and preparation note must be delivered' USING ERRCODE='23514'; END IF;
   ELSIF NEW.task_kind='qa' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
     WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.kind='qa_text' AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
     AND v.id=NEW.artifact_id AND v.version=NEW.artifact_version AND v.media_type='text/plain' AND v.delivery_status='available')
   THEN RAISE EXCEPTION 'M4 QA text must be delivered' USING ERRCODE='23514'; END IF;
 END IF;
 remaining_charge:=charged;
 FOR a IN SELECT * FROM bb_credit_allocations WHERE reservation_id=r.id ORDER BY lot_id LOOP
   SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=a.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
   take:=LEAST(a.points,remaining_charge); remaining_charge:=remaining_charge-take;
   UPDATE bb_credit_lots SET frozen=frozen-a.points,remaining=remaining-take WHERE id=l.id;
   IF NEW.state='failed' AND l.expires_at<=now() THEN
     UPDATE bb_credit_lots SET remaining=remaining-a.points WHERE id=l.id;
     compensation:='failure:'||r.id||':'||l.id;
     INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
       VALUES(compensation,NEW.owner_user_id,'failure_compensation',compensation,a.points,a.points,now()+interval '7 days');
     INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,run_id,actor,reason)
       VALUES(compensation,NEW.owner_user_id,compensation,'grant',a.points,compensation,NEW.id,'system','expired_hold_platform_failure');
   END IF;
 END LOOP;
 UPDATE bb_credit_reservations SET state=CASE WHEN NEW.state='succeeded' THEN 'settled' ELSE 'released' END,charged_points=charged,finalized_at=now() WHERE id=r.id;
 IF charged>0 THEN INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
   VALUES('final:'||r.id,NEW.owner_user_id,'final:'||r.id,'settle',charged,r.id,NEW.id,'system','m4_verified_cost_capped'); END IF;
 IF r.points>charged THEN INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
   VALUES('release:'||r.id,NEW.owner_user_id,'release:'||r.id,'release',r.points-charged,r.id,NEW.id,'system',NEW.state); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_m4_credit_finalize AFTER UPDATE OF state ON bb_runs FOR EACH ROW EXECUTE FUNCTION bb_m4_credit_finalize_run();

-- Canonical project lock prevents executions across M4 topics from bypassing the source project.
CREATE OR REPLACE FUNCTION bb_m3_project_run_mutex() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_kind text; scope_id text; is_m4_scope boolean;
BEGIN
 IF NEW.task_kind='qa' OR NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected') THEN RETURN NEW; END IF;
 SELECT kind,COALESCE(execution_scope_project_id,id) INTO project_kind,scope_id FROM bb_projects
 WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id;
 PERFORM 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=scope_id FOR UPDATE;
 SELECT EXISTS(SELECT 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND execution_scope_project_id=scope_id) INTO is_m4_scope;
 IF (project_kind='review' OR is_m4_scope) AND EXISTS (
   SELECT 1 FROM bb_runs r JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
   WHERE r.owner_user_id=NEW.owner_user_id AND COALESCE(p.execution_scope_project_id,p.id)=scope_id AND r.id<>NEW.id
   AND r.task_kind<>'qa' AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
 ) THEN RAISE EXCEPTION 'Project already has an active business run' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
