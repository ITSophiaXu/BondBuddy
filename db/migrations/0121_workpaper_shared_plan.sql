-- New direct batches share one immutable source extraction and one authoring plan.
-- Existing run, quote, item-attempt, cancellation and artifact contracts are retained.
CREATE TABLE bb_workpaper_shared_sources (
 owner_user_id text NOT NULL,batch_id text NOT NULL,input_hash char(64) NOT NULL,
 snapshot jsonb NOT NULL,snapshot_hash char(64) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,batch_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_batches(owner_user_id,id)
);
CREATE TABLE bb_workpaper_shared_plans (
 owner_user_id text NOT NULL,batch_id text NOT NULL,input_hash char(64) NOT NULL,
 method_hash char(64) NOT NULL,source_hash char(64) NOT NULL,
 plan jsonb NOT NULL,plan_hash char(64) NOT NULL,author_run_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,batch_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_shared_sources(owner_user_id,batch_id),
 FOREIGN KEY(owner_user_id,author_run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_shared_sources_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_shared_sources FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_workpaper_shared_plans_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_shared_plans FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
