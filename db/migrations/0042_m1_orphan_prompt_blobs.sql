-- #79: a committed intent precedes every prompt Blob write.  A failed reference
-- insert cannot erase the cleanup address, even when compensating deletion fails.
-- Apply after pending 0040 (#207) and 0041 (#236); neither is rewritten here.
CREATE TABLE bb_prompt_blob_intents (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 object_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 cleanup_after timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
 registered_at timestamptz,
 cleared_at timestamptz,
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 CHECK (object_key LIKE 'users/' || owner_user_id || '/projects/' || project_id || '/snapshots/%'),
 CHECK (NOT (registered_at IS NOT NULL AND cleared_at IS NOT NULL))
);
CREATE INDEX bb_prompt_blob_intents_due_idx
 ON bb_prompt_blob_intents(cleanup_after,id) WHERE registered_at IS NULL AND cleared_at IS NULL;

-- Direct reference registration for an intent must serialize with the sweeper.
-- Older references without intents remain valid; the writer adopts intents on upgrade.
CREATE FUNCTION bb_lock_prompt_blob_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent bb_prompt_blob_intents%ROWTYPE;
BEGIN
 SELECT * INTO intent FROM bb_prompt_blob_intents WHERE object_key=NEW.object_key FOR UPDATE;
 IF FOUND AND (intent.cleared_at IS NOT NULL OR intent.owner_user_id<>NEW.owner_user_id OR intent.project_id<>NEW.project_id) THEN
   RAISE EXCEPTION 'prompt Blob intent is cleared or has different owner' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_snapshot_ref_intent_guard BEFORE INSERT ON bb_snapshot_refs
 FOR EACH ROW EXECUTE FUNCTION bb_lock_prompt_blob_intent();
