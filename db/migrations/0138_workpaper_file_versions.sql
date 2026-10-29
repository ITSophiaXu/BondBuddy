-- A catalogue identity is a document family; each successful compilation remains
-- an immutable version.  A batch item always retains its original delivery pin.
ALTER TABLE bb_project_files ADD COLUMN identity_key text NOT NULL DEFAULT '';
ALTER TABLE bb_project_files DROP CONSTRAINT bb_project_files_project_id_document_type_key;
ALTER TABLE bb_project_files ADD UNIQUE(project_id,document_type,identity_key);
CREATE FUNCTION bb_workpaper_identity_key(entry jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT 'workpaper:'||md5(jsonb_build_array(entry->>'sheet',entry->>'title',entry->>'path',coalesce(nullif(entry->>'code',''),entry->>'title'))::text)
$$;
ALTER TABLE bb_workpaper_items ADD UNIQUE(owner_user_id,batch_id,item_id);
CREATE TABLE bb_workpaper_file_bindings (
 owner_user_id text NOT NULL,batch_id text NOT NULL,item_id text NOT NULL,file_id text NOT NULL,original_version_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(batch_id,item_id),UNIQUE(owner_user_id,original_version_id),
 FOREIGN KEY(owner_user_id,batch_id,item_id) REFERENCES bb_workpaper_items(owner_user_id,batch_id,item_id),
 FOREIGN KEY(owner_user_id,file_id) REFERENCES bb_project_files(owner_user_id,id),
 FOREIGN KEY(owner_user_id,original_version_id) REFERENCES bb_project_file_versions(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_file_binding_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_file_bindings
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Adopt only genuine available Word artifacts. Explanation objects without an
-- artifact version are deliberately excluded; no placeholder pin is fabricated.
CREATE TEMP TABLE delivered_workpaper_versions ON COMMIT DROP AS
 SELECT i.owner_user_id,i.batch_id,i.item_id,i.run_id,b.project_id,b.source->>'version_id' AS source_version_id,
 bb_workpaper_identity_key(i.manifest->'input'->'workpaper'->'entry') AS identity_key,
 a.filename,a.artifact_id,a.artifact_version,v.sha256,r.project_id AS artifact_project_id,b.created_at
 FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
 JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id AND r.state='succeeded'
 JOIN bb_m4_artifacts a ON a.owner_user_id=i.owner_user_id AND a.run_id=i.run_id AND a.kind='document' AND a.document_type='workpaper'
 JOIN bb_artifact_versions v ON v.owner_user_id=a.owner_user_id AND v.id=a.artifact_id AND v.version=a.artifact_version
 LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id
 WHERE v.delivery_status='available' AND v.quality_status='passed'
 AND v.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
 AND coalesce(i.explanation,w.explanation) IS NULL;
INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type,identity_key)
 SELECT 'workpaper-file-'||md5(owner_user_id||':'||project_id||':'||identity_key),owner_user_id,project_id,'workpaper',identity_key
 FROM delivered_workpaper_versions GROUP BY owner_user_id,project_id,identity_key;
INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,source_version_id,run_id,created_at)
 SELECT 'workpaper-version-'||md5(d.owner_user_id||':'||d.run_id),d.owner_user_id,f.id,
 row_number() OVER(PARTITION BY f.id ORDER BY d.created_at,d.batch_id,d.item_id)::int,d.filename,
 jsonb_build_object('kind','artifact','pin',jsonb_build_object('source_project_id',d.artifact_project_id,'artifact_id',d.artifact_id,'artifact_version',d.artifact_version,'sha256',trim(d.sha256))),
 d.source_version_id,d.run_id,d.created_at
 FROM delivered_workpaper_versions d JOIN bb_project_files f ON f.owner_user_id=d.owner_user_id AND f.project_id=d.project_id AND f.document_type='workpaper' AND f.identity_key=d.identity_key;
INSERT INTO bb_workpaper_file_bindings(owner_user_id,batch_id,item_id,file_id,original_version_id)
 SELECT d.owner_user_id,d.batch_id,d.item_id,v.file_id,v.id FROM delivered_workpaper_versions d
 JOIN bb_project_file_versions v ON v.owner_user_id=d.owner_user_id AND v.run_id=d.run_id;
UPDATE bb_project_files f SET latest_version_id=(SELECT v.id FROM bb_project_file_versions v WHERE v.file_id=f.id ORDER BY v.sequence DESC LIMIT 1)
 WHERE f.document_type='workpaper';
