-- Host-only pagination repairs are append-only descendants of a paid delivery.
-- No run, original artifact, model observation or billing row is rewritten.
CREATE TABLE bb_workpaper_layout_revisions (
 id text PRIMARY KEY,owner_user_id text NOT NULL,file_id text NOT NULL,
 parent_version_id text NOT NULL,new_version_id text NOT NULL,
 batch_id text NOT NULL,item_id text NOT NULL,run_id text NOT NULL,
 method text NOT NULL CHECK(method='host-workpaper-pagination-20261119-v2'),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 128),
 input_sha256 char(64) NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
 output_sha256 char(64) NOT NULL CHECK(output_sha256 ~ '^[0-9a-f]{64}$'),
 receipt jsonb NOT NULL,receipt_sha256 char(64) NOT NULL CHECK(receipt_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,parent_version_id,method),UNIQUE(owner_user_id,new_version_id),
 CHECK(parent_version_id<>new_version_id AND input_sha256<>output_sha256),
 FOREIGN KEY(owner_user_id,file_id) REFERENCES bb_project_files(owner_user_id,id),
 FOREIGN KEY(owner_user_id,parent_version_id) REFERENCES bb_project_file_versions(owner_user_id,id),
 FOREIGN KEY(owner_user_id,new_version_id) REFERENCES bb_project_file_versions(owner_user_id,id),
 FOREIGN KEY(owner_user_id,batch_id,item_id) REFERENCES bb_workpaper_items(owner_user_id,batch_id,item_id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_layout_revision_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_layout_revisions
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE FUNCTION bb_guard_workpaper_layout_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM bb_workpaper_file_bindings b
  JOIN bb_project_file_versions p ON p.owner_user_id=b.owner_user_id AND p.id=b.original_version_id AND p.file_id=b.file_id
  JOIN bb_project_file_versions v ON v.owner_user_id=p.owner_user_id AND v.id=NEW.new_version_id AND v.file_id=p.file_id
  JOIN bb_project_files f ON f.owner_user_id=b.owner_user_id AND f.id=b.file_id AND f.document_type='workpaper'
  JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.id=p.run_id AND r.state='succeeded'
  JOIN bb_artifact_versions a ON a.owner_user_id=r.owner_user_id AND a.run_id=r.id
    AND a.id=v.asset->'pin'->>'artifact_id' AND a.version=(v.asset->'pin'->>'artifact_version')::integer
  WHERE b.owner_user_id=NEW.owner_user_id AND b.file_id=NEW.file_id AND b.batch_id=NEW.batch_id AND b.item_id=NEW.item_id
    AND b.original_version_id=NEW.parent_version_id AND p.run_id=NEW.run_id AND v.run_id IS NULL
    AND v.sequence=p.sequence+1 AND f.latest_version_id=v.id AND p.asset->>'kind'='artifact' AND v.asset->>'kind'='artifact'
    AND p.asset->'pin'->>'sha256'=trim(NEW.input_sha256) AND v.asset->'pin'->>'sha256'=trim(NEW.output_sha256)
    AND a.sha256=NEW.output_sha256 AND a.quality_status='passed' AND a.delivery_status='available'
    AND v.asset->'pin'->>'source_project_id'=r.project_id
    AND v.source_version_id IS NOT DISTINCT FROM p.source_version_id
 ) OR NEW.receipt->>'input_sha256' IS DISTINCT FROM trim(NEW.input_sha256)
   OR NEW.receipt->>'output_sha256' IS DISTINCT FROM trim(NEW.output_sha256)
   OR NEW.receipt->>'content_unchanged' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'workpaper layout revision identity mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_layout_revision_guard BEFORE INSERT ON bb_workpaper_layout_revisions
 FOR EACH ROW EXECUTE FUNCTION bb_guard_workpaper_layout_revision();
