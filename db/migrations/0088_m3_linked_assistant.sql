-- Additive linked-workspace contracts. Keep v1 message/call snapshots untouched.
ALTER TABLE bb_review_messages ADD COLUMN reply_metadata jsonb;
CREATE FUNCTION bb_guard_review_reply_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.reply_metadata IS DISTINCT FROM OLD.reply_metadata THEN
   RAISE EXCEPTION 'Review reply metadata is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_review_reply_metadata_immutable BEFORE UPDATE ON bb_review_messages
 FOR EACH ROW EXECUTE FUNCTION bb_guard_review_reply_metadata();

CREATE TABLE bb_review_proposal_adoptions (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL,
 adoption_request_id text NOT NULL, request_sha256 char(64) NOT NULL,
 content_sha256 char(64) NOT NULL, acceptance jsonb NOT NULL, input jsonb NOT NULL, plan jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,adoption_request_id), UNIQUE(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TRIGGER bb_review_proposal_adoption_immutable BEFORE UPDATE OR DELETE ON bb_review_proposal_adoptions
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
