-- #712: keep business project identity; update execution reuses the existing runtime.
CREATE TABLE bb_update_workspaces (
 owner_user_id text NOT NULL, source_project_id text NOT NULL, update_project_id text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_user_id,source_project_id),
 FOREIGN KEY(owner_user_id,source_project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,update_project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_update_material_copies (
 owner_user_id text NOT NULL, project_id text NOT NULL, source_project_id text NOT NULL,
 source_material_id text NOT NULL, source_material_version integer NOT NULL, upload_id text NOT NULL,
 material_id text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,source_material_id,source_material_version),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,source_material_id,source_material_version) REFERENCES bb_material_versions(owner_user_id,id,version),
 FOREIGN KEY(owner_user_id,upload_id) REFERENCES bb_uploads(owner_user_id,id)
);
CREATE TABLE bb_prospectus_versions (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, sequence integer NOT NULL CHECK(sequence>0),
 origin text NOT NULL CHECK(origin IN ('upload','generated')), filename text NOT NULL, sha256 char(64) NOT NULL,
 material_id text, material_version integer, artifact_id text, artifact_version integer, revision_artifact_id text, run_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,project_id,id), UNIQUE(project_id,sequence), UNIQUE(project_id,material_id,material_version), UNIQUE(project_id,run_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,material_id,material_version) REFERENCES bb_material_versions(owner_user_id,id,version),
 FOREIGN KEY(owner_user_id,artifact_id,artifact_version) REFERENCES bb_artifact_versions(owner_user_id,id,version),
 CHECK((origin='upload' AND material_id IS NOT NULL AND material_version IS NOT NULL AND artifact_id IS NULL AND run_id IS NULL)
    OR (origin='generated' AND material_id IS NULL AND artifact_id IS NOT NULL AND artifact_version IS NOT NULL AND run_id IS NOT NULL))
);
CREATE TRIGGER bb_prospectus_versions_immutable BEFORE UPDATE OR DELETE ON bb_prospectus_versions FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_prospectus_selection (
 owner_user_id text NOT NULL, project_id text PRIMARY KEY, version_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 FOREIGN KEY(owner_user_id,project_id,version_id) REFERENCES bb_prospectus_versions(owner_user_id,project_id,id)
);
CREATE TABLE bb_prospectus_selection_requests (
 owner_user_id text NOT NULL, project_id text NOT NULL, request_id text NOT NULL, request_hash char(64) NOT NULL,
 PRIMARY KEY(owner_user_id,project_id,request_id), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
