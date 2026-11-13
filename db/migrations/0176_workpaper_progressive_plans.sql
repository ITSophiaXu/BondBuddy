-- Progressive runs share the complete source snapshot but accept each item's
-- plan independently. A failed item cannot replace a sibling's accepted plan.
CREATE TABLE bb_workpaper_progressive_plans (
 owner_user_id text NOT NULL,batch_id text NOT NULL,item_id text NOT NULL,
 input_hash char(64) NOT NULL,method_hash char(64) NOT NULL,source_hash char(64) NOT NULL,
 plan jsonb NOT NULL,plan_hash char(64) NOT NULL,author_run_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,batch_id,item_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_shared_sources(owner_user_id,batch_id),
 FOREIGN KEY(owner_user_id,batch_id,item_id) REFERENCES bb_workpaper_items(owner_user_id,batch_id,item_id),
 FOREIGN KEY(owner_user_id,author_run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_progressive_plans_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_progressive_plans FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
