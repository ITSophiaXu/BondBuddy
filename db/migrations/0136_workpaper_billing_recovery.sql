-- Only a verified task admission shortage may offer payment-assisted resumption.
ALTER TABLE bb_workpaper_batches ADD COLUMN pause_reason text
 CHECK (pause_reason IS NULL OR pause_reason='credits_insufficient');

CREATE TABLE bb_workpaper_billing_resumes (
 owner_user_id text NOT NULL,request_id text NOT NULL,batch_id text NOT NULL,request_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_batches(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_billing_resume_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_billing_resumes
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
