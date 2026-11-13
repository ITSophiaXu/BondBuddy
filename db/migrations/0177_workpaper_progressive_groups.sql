-- A bounded chapter plan is accepted once. Only per-item hashes and failure
-- receipts live here; source text/images and item coverage are not duplicated.
CREATE TABLE bb_workpaper_progressive_groups (
 owner_user_id text NOT NULL,batch_id text NOT NULL,group_id char(64) NOT NULL,
 input_hash char(64) NOT NULL,method_hash char(64) NOT NULL,source_hash char(64) NOT NULL,
 receipt jsonb NOT NULL,receipt_hash char(64) NOT NULL,author_run_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,batch_id,group_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_shared_sources(owner_user_id,batch_id),
 FOREIGN KEY(owner_user_id,author_run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_progressive_groups_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_progressive_groups FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
