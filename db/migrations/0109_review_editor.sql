-- Immutable editor snapshots are produced by the trusted writer, never by the browser.
CREATE TABLE bb_review_editors (
 owner_user_id text NOT NULL, project_id text NOT NULL, run_id text PRIMARY KEY,
 snapshot jsonb NOT NULL, sha256 char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_review_editors_immutable BEFORE UPDATE OR DELETE ON bb_review_editors FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_review_source_imports (
 owner_user_id text NOT NULL, project_id text NOT NULL, version_id text NOT NULL, material_id text NOT NULL, material_version integer NOT NULL DEFAULT 1 CHECK(material_version=1),
 PRIMARY KEY(project_id,version_id),
 FOREIGN KEY(owner_user_id,project_id,version_id) REFERENCES bb_prospectus_versions(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,material_id,material_version) REFERENCES bb_material_versions(owner_user_id,id,version)
);
