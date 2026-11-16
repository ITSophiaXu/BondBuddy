-- #1415 advisory performance telemetry; never participates in model evidence or billing.
CREATE TABLE bb_performance_sessions (
 session_id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
 job_id text, trace_id text NOT NULL, run_execution_id text NOT NULL, task_kind text NOT NULL,
 service_role text, worker_instance_id text, release_sha text,
 started_at timestamptz NOT NULL, ended_at timestamptz, last_flush_at timestamptz,
 closed boolean NOT NULL DEFAULT false, generated integer NOT NULL DEFAULT 0 CHECK(generated>=0),
 acknowledged integer NOT NULL DEFAULT 0 CHECK(acknowledged>=0 AND acknowledged<=generated),
 dropped integer NOT NULL DEFAULT 0 CHECK(dropped>=0), invalid_attributes integer NOT NULL DEFAULT 0 CHECK(invalid_attributes>=0),
 flush_errors integer NOT NULL DEFAULT 0 CHECK(flush_errors>=0), last_sequence integer NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
 complete boolean NOT NULL DEFAULT false,
 purged_at timestamptz, purged_span_count integer NOT NULL DEFAULT 0 CHECK(purged_span_count>=0),
 purge_reason text CHECK(purge_reason IN ('retention_expired','user_deleted')), purge_policy_version text,
 CHECK((purged_at IS NULL AND purged_span_count=0 AND purge_reason IS NULL AND purge_policy_version IS NULL) OR
       (purged_at IS NOT NULL AND purge_reason IS NOT NULL AND purge_policy_version IS NOT NULL AND NOT complete)),
 UNIQUE(owner_user_id,run_id,session_id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 CHECK(ended_at IS NULL OR ended_at>=started_at),
 CHECK(NOT complete OR (closed AND ended_at IS NOT NULL AND acknowledged=generated AND dropped=0 AND invalid_attributes=0 AND flush_errors=0 AND purged_at IS NULL))
);
CREATE INDEX bb_performance_sessions_run ON bb_performance_sessions(owner_user_id,run_id,started_at,session_id);
CREATE INDEX bb_performance_sessions_retention ON bb_performance_sessions(started_at,session_id);
CREATE TABLE bb_performance_spans (
 span_id text PRIMARY KEY, owner_user_id text NOT NULL, run_id text NOT NULL, session_id text NOT NULL,
 run_execution_id text NOT NULL, trace_id text NOT NULL, job_id text, parent_span_id text,
 stage text, step_key text NOT NULL CHECK(step_key ~ '^[a-z][a-z0-9_.]{0,127}$'), step_version integer NOT NULL DEFAULT 1 CHECK(step_version=1),
 status text NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','paused','reused','interrupted')),
 started_at timestamptz NOT NULL, ended_at timestamptz, duration_ms double precision,
 last_activity_at timestamptz NOT NULL, clock_source text NOT NULL CHECK(clock_source IN ('monotonic','database_event_interval','wall_clock_observation')),
 attributes jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(attributes)='object' AND octet_length(attributes::text)<=8192),
 span_links jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(span_links)='array' AND jsonb_array_length(span_links)<=16),
 sequence integer NOT NULL CHECK(sequence>0), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(owner_user_id,run_id,session_id) REFERENCES bb_performance_sessions(owner_user_id,run_id,session_id),
 CHECK(duration_ms IS NULL OR (duration_ms>=0 AND duration_ms<'Infinity'::double precision)),
 CHECK((status='running' AND ended_at IS NULL AND duration_ms IS NULL) OR (status<>'running' AND ended_at IS NOT NULL AND duration_ms IS NOT NULL)),
 CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE INDEX bb_performance_spans_run_page ON bb_performance_spans(owner_user_id,run_id,started_at,span_id);
CREATE INDEX bb_performance_spans_session ON bb_performance_spans(session_id);
CREATE INDEX bb_performance_spans_step ON bb_performance_spans(step_key,started_at);
-- Retention deletes spans and keeps session purge receipts; retries cannot resurrect purged sessions.
