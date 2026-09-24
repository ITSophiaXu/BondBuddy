-- #15 conflict decisions are an append-only audit trail. Candidates remain
-- untouched; this records what a trusted actor chose for one exact identity.
CREATE TABLE bb_fact_decisions (
 id text PRIMARY KEY,
 request_id text NOT NULL,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 fact_key_hash char(64) NOT NULL CHECK (fact_key_hash ~ '^[a-f0-9]{64}$'),
 fact_key jsonb NOT NULL CHECK (jsonb_typeof(fact_key) = 'object'),
 version integer NOT NULL CHECK (version > 0),
 resolution text NOT NULL CHECK (resolution IN ('selected','unresolved')),
 selected_candidate_id text,
 selected_candidate_provenance jsonb,
 reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 2000),
 actor_kind text NOT NULL CHECK (actor_kind IN ('user','internal_reviewer','system')),
 actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_user_id, project_id, request_id),
 UNIQUE (owner_user_id, project_id, fact_key_hash, version),
 FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id, project_id, selected_candidate_id)
   REFERENCES bb_fact_candidates(owner_user_id, project_id, id),
 CHECK ((resolution = 'selected' AND selected_candidate_id IS NOT NULL AND selected_candidate_provenance IS NOT NULL)
     OR (resolution = 'unresolved' AND selected_candidate_id IS NULL AND selected_candidate_provenance IS NULL))
);
CREATE INDEX bb_fact_decisions_identity_idx
 ON bb_fact_decisions(owner_user_id, project_id, fact_key_hash, version DESC);

-- Protect append-only behavior at the database boundary, including accidental
-- maintenance code attempting to rewrite or delete the audit record.
CREATE FUNCTION bb_reject_fact_decision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fact decisions are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_fact_decision_immutable
 BEFORE UPDATE OR DELETE ON bb_fact_decisions
 FOR EACH ROW EXECUTE FUNCTION bb_reject_fact_decision_change();

-- Once a candidate is named by an audit decision, freeze its source and value
-- provenance. Unreferenced candidates retain the existing repository lifecycle.
CREATE FUNCTION bb_reject_decided_fact_candidate_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM bb_fact_decisions d
             WHERE d.owner_user_id = OLD.owner_user_id AND d.project_id = OLD.project_id
               AND d.selected_candidate_id = OLD.id) THEN
  RAISE EXCEPTION 'fact candidate is referenced by an immutable decision' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_decided_fact_candidate_immutable
 BEFORE UPDATE OR DELETE ON bb_fact_candidates
 FOR EACH ROW EXECUTE FUNCTION bb_reject_decided_fact_candidate_change();
