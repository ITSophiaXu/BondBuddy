-- #79 foundation. Evidence rows and snapshot metadata are append-only; no prompt body or credential is stored here.
CREATE TABLE bb_operations (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text, run_id text,
 request_id text NOT NULL, trace_id text NOT NULL, operation_kind text NOT NULL,
 status text NOT NULL CHECK (status IN ('submitted','rejected')),
 error_code text, input_revision integer, input_hash char(64),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 CHECK ((status='rejected') = (error_code IS NOT NULL))
);
CREATE INDEX bb_operations_lookup_idx ON bb_operations(owner_user_id,project_id,created_at DESC);
CREATE INDEX bb_operations_trace_idx ON bb_operations(owner_user_id,trace_id);
CREATE TABLE bb_snapshot_refs (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, run_id text,
 snapshot_kind text NOT NULL CHECK (snapshot_kind IN ('user_prompt','model_request','structured_input')),
 version integer NOT NULL CHECK (version>0), object_key text NOT NULL UNIQUE,
 content_sha256 char(64) NOT NULL, redaction_version text NOT NULL,
 input_revision integer, input_hash char(64), template_version text, rule_pack_version text, model_parameters_version text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,project_id,snapshot_kind,version),
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY (owner_user_id,project_id,input_revision) REFERENCES bb_input_revisions(owner_user_id,project_id,revision),
 CHECK (object_key LIKE 'users/' || owner_user_id || '/projects/' || project_id || '/snapshots/%'),
 CHECK (input_revision IS NULL OR input_hash IS NOT NULL)
);
ALTER TABLE bb_model_call_attempts ADD COLUMN model_id text;
ALTER TABLE bb_model_call_attempts ADD COLUMN prompt_snapshot_id text;
ALTER TABLE bb_model_call_attempts ADD COLUMN usage_evidence_ref text;
ALTER TABLE bb_model_call_attempts ADD CONSTRAINT bb_call_prompt_fk FOREIGN KEY(prompt_snapshot_id) REFERENCES bb_snapshot_refs(id);
ALTER TABLE bb_model_call_attempts ADD CONSTRAINT bb_call_owner_id UNIQUE(owner_user_id,id);
CREATE TABLE bb_usage_observations (
 id text PRIMARY KEY, owner_user_id text NOT NULL, attempt_id text NOT NULL,
 FOREIGN KEY (owner_user_id,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,id),
 source text NOT NULL CHECK (source IN ('provider','gateway','framework','reconciliation')),
 source_event_id text NOT NULL, usage_status text NOT NULL CHECK (usage_status IN ('unknown','pending','measured')),
 input_tokens integer, output_tokens integer, cached_input_tokens integer, reasoning_tokens integer,
 evidence_ref text, observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,source,source_event_id),
 CHECK (input_tokens IS NULL OR input_tokens>=0), CHECK (output_tokens IS NULL OR output_tokens>=0),
 CHECK (cached_input_tokens IS NULL OR cached_input_tokens>=0), CHECK (reasoning_tokens IS NULL OR reasoning_tokens>=0),
 CHECK ((usage_status='measured' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL) OR
        (usage_status<>'measured' AND input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL AND reasoning_tokens IS NULL)),
 CHECK (cached_input_tokens IS NULL OR cached_input_tokens<=input_tokens),
 CHECK (reasoning_tokens IS NULL OR reasoning_tokens<=output_tokens)
);
CREATE INDEX bb_usage_owner_idx ON bb_usage_observations(owner_user_id,attempt_id);
CREATE TABLE bb_observability_errors (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text, operation_id text REFERENCES bb_operations(id),
 job_id text, attempt_id text, trace_id text NOT NULL,
 code text NOT NULL, category text NOT NULL, stage text, provider_status integer,
 retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count>=0), fingerprint char(64) CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 safe_message_code text, recovery_status text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,job_id) REFERENCES bb_jobs(owner_user_id,id),
 FOREIGN KEY (owner_user_id,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,id),
 CHECK (safe_message_code IS NULL OR safe_message_code ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE INDEX bb_errors_lookup_idx ON bb_observability_errors(owner_user_id,project_id,created_at DESC);
CREATE TABLE bb_observability_events (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text, job_id text,
 run_id text, trace_id text NOT NULL, kind text NOT NULL, event jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,job_id) REFERENCES bb_jobs(owner_user_id,id),
 FOREIGN KEY (owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE INDEX bb_observability_timeline_idx ON bb_observability_events(owner_user_id,project_id,created_at,id);
CREATE TABLE bb_log_access_audit (
 id text PRIMARY KEY, actor_id text NOT NULL, owner_user_id text NOT NULL, purpose text NOT NULL,
 filter_hash char(64) NOT NULL, accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_log_access_owner_idx ON bb_log_access_audit(owner_user_id,accessed_at DESC);
ALTER TABLE bb_outbox ADD COLUMN lease_token text;
ALTER TABLE bb_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE bb_outbox ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE bb_outbox ADD CONSTRAINT bb_outbox_lease_pair CHECK ((lease_token IS NULL) = (lease_until IS NULL));
-- A measured observation is chosen once per actual attempt, regardless of gateway/framework duplicates.
-- Cached input and reasoning output are subsets, never added to total tokens.
CREATE VIEW bb_call_usage AS
SELECT a.id attempt_id,a.owner_user_id,a.job_id,a.logical_call_id,a.attempt_no,a.status call_status,
 COALESCE(m.usage_status,CASE WHEN EXISTS (SELECT 1 FROM bb_usage_observations u WHERE u.attempt_id=a.id AND u.usage_status='pending') THEN 'pending' ELSE 'unknown' END) usage_status,
 m.input_tokens,m.output_tokens,m.cached_input_tokens,m.reasoning_tokens,
 (SELECT count(*)::integer FROM bb_usage_observations u WHERE u.attempt_id=a.id AND u.usage_status='measured' AND (u.input_tokens,u.output_tokens) IS DISTINCT FROM (m.input_tokens,m.output_tokens)) conflicting_measurements
FROM bb_model_call_attempts a
LEFT JOIN LATERAL (SELECT * FROM bb_usage_observations u WHERE u.attempt_id=a.id AND u.usage_status='measured' ORDER BY u.observed_at,u.id LIMIT 1) m ON true;
CREATE TRIGGER bb_snapshot_ref_immutable BEFORE UPDATE OR DELETE ON bb_snapshot_refs FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_usage_immutable BEFORE UPDATE OR DELETE ON bb_usage_observations FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_operation_immutable BEFORE UPDATE OR DELETE ON bb_operations FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_observability_event_immutable BEFORE UPDATE OR DELETE ON bb_observability_events FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_log_access_immutable BEFORE UPDATE OR DELETE ON bb_log_access_audit FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_observability_error_immutable BEFORE UPDATE OR DELETE ON bb_observability_errors FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
