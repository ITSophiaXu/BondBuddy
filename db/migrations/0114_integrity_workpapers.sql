-- Separate company / person workpapers match the approved project file catalogue.
CREATE TABLE bb_integrity_artifacts (
 owner_user_id text NOT NULL,run_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('company','person')),
 artifact_id text NOT NULL,artifact_version integer NOT NULL,
 PRIMARY KEY(run_id,kind),UNIQUE(artifact_id,artifact_version),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_integrity_runs(owner_user_id,run_id),
 FOREIGN KEY(owner_user_id,artifact_id,artifact_version) REFERENCES bb_artifact_versions(owner_user_id,id,version)
);
CREATE TRIGGER bb_integrity_artifacts_immutable BEFORE UPDATE OR DELETE ON bb_integrity_artifacts FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
