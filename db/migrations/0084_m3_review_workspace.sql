-- M3: owner scoped drafts, immutable execution/report/accepted-plan snapshots.
-- No user billing tables, reservations, balance checks or ledger events.
CREATE TABLE bb_review_drafts (
 owner_user_id text NOT NULL, project_id text NOT NULL, version integer NOT NULL CHECK(version>0), input jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_user_id,project_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_review_message_drafts (
 owner_user_id text NOT NULL, project_id text NOT NULL, context_hash char(64) NOT NULL, context jsonb NOT NULL,
 version integer NOT NULL CHECK(version>0), content text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,project_id,context_hash), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_review_messages (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, submission_request_id text NOT NULL,
 request_hash char(64) NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
 context jsonb NOT NULL, reply_status text NOT NULL CHECK(reply_status IN ('queued','running','completed','failed','unknown')),
 reply_to text REFERENCES bb_review_messages(id), proposal jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,submission_request_id), UNIQUE(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_review_revision_plans (
 id text NOT NULL, version integer NOT NULL CHECK(version>0), owner_user_id text NOT NULL, project_id text NOT NULL,
 content_sha256 char(64) NOT NULL, accepted_at timestamptz NOT NULL, plan jsonb NOT NULL,
 PRIMARY KEY(id,version), UNIQUE(owner_user_id,project_id,version),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_review_executions (
 run_id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, version integer NOT NULL CHECK(version>0),
 operation text NOT NULL CHECK(operation IN ('full_review','differential_review','revision')), source_report_id text,
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,project_id,version),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id)
);
CREATE TABLE bb_review_reports (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL UNIQUE,
 version integer NOT NULL CHECK(version>0), content_sha256 char(64) NOT NULL, report jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id)
);
CREATE TABLE bb_review_artifacts (
 owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL, artifact_id text NOT NULL, artifact_version integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('report','comments','revision','clean','baseline')), filename text NOT NULL,
 PRIMARY KEY(run_id,kind), FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,artifact_id,artifact_version) REFERENCES bb_artifact_versions(owner_user_id,id,version)
);
CREATE TRIGGER bb_review_report_immutable BEFORE UPDATE OR DELETE ON bb_review_reports FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_review_plan_immutable BEFORE UPDATE OR DELETE ON bb_review_revision_plans FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_review_execution_immutable BEFORE UPDATE OR DELETE ON bb_review_executions FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_model_web_search_evidence (
 call_id text PRIMARY KEY REFERENCES bb_model_call_attempts(id), owner_user_id text NOT NULL, project_id text NOT NULL,
 run_id text NOT NULL, job_id text NOT NULL, logical_call_id text NOT NULL, content_sha256 char(64) NOT NULL,
 events jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,job_id) REFERENCES bb_jobs(owner_user_id,id)
);
CREATE TRIGGER bb_web_search_immutable BEFORE UPDATE OR DELETE ON bb_model_web_search_evidence FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
