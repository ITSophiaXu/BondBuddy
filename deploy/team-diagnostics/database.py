"""Fixed SELECT-only queries over explicit diagnostic projections, never arbitrary SQL."""
import json

from common import canonical, command, cursor_decode, cursor_encode, digest, identifier, scrub
from archive import timestamp
from collector import DOCKER, discover

# Each projection is explicit. Newly added credential/config columns are never inherited.
SPECS = {
    'users': ('bb_users', 'id username status created_at'),
    'runs': ('bb_runs', 'id owner_user_id project_id task_kind state stage event_cursor artifact_id artifact_version created_at updated_at'),
    'jobs': ('bb_jobs', 'id owner_user_id project_id run_id job_type subtype state stage lease_until attempts max_attempts error_code created_at updated_at execution_node_id execution_node_epoch execution_session_id'),
    'attempts': ('bb_model_call_attempts', 'id owner_user_id job_id logical_call_id attempt_no status usage_status model_id provider_request_id prompt_snapshot_id user_submission_id created_at updated_at'),
    'runtime': ('bb_model_call_attempt_runtime', 'id owner_user_id project_id job_id run_id trace_id attempt_id logical_call_id attempt_no adapter adapter_version model_provider model_config_version started_at duration_ms exit_code exit_signal exit_capture_status finish_reason finish_reason_capture_status error_code recorded_at'),
    'execution-configs': ('bb_model_attempt_execution_configs', 'attempt_id owner_user_id project_id run_id job_id logical_call_id attempt_no effective_timeout_ms timeout_deadline_at timeout_source timeout_branch model_config_version loaded_adapter_sha256 selected_config_sha256 release_sha overlay_sha256 recorded_at'),
    'result-failures': ('bb_model_result_failure_diagnostics', 'id attempt_id owner_user_id project_id run_id job_id logical_call_id attempt_no substage error_class error_code recorded_at'),
    'usage': ('bb_call_usage_effective', 'attempt_id owner_user_id job_id logical_call_id attempt_no call_status usage_status input_tokens output_tokens cached_input_tokens reasoning_tokens correction_id'),
    'observations': ('bb_provider_call_observations', 'id owner_user_id project_id job_id run_id attempt_id logical_call_id attempt_no outcome usage_status usage error_code provider_status provider_request_id observed_at'),
    'usage-observations': ('bb_usage_observations', 'id owner_user_id attempt_id source usage_status input_tokens output_tokens cached_input_tokens reasoning_tokens provider_request_id observed_at created_at'),
    'errors': ('bb_observability_errors', 'id owner_user_id project_id job_id attempt_id trace_id code category stage provider_status provider_error_type retry_count fingerprint safe_message safe_stack recovery_status created_at'),
    'events': ('bb_observability_events', 'id owner_user_id project_id job_id run_id trace_id kind event created_at'),
    'operations': ('bb_operations', 'id owner_user_id project_id run_id request_id trace_id operation_kind status error_code created_at'),
    'run-events': ('bb_run_events', 'seq owner_user_id run_id type state stage payload occurred_at'),
    'job-events': ('bb_job_events', 'seq owner_user_id job_id type state stage payload occurred_at'),
    'outbox': ('bb_outbox', 'id owner_user_id aggregate_type aggregate_id event_type created_at delivered_at delivery_attempts last_delivery_error next_attempt_at lease_until'),
    'prompts': ('bb_snapshot_refs', 'id owner_user_id project_id run_id snapshot_kind version content_sha256 redaction_version created_at'),
    'submissions': ('bb_user_submission_versions', 'id owner_user_id project_id run_id submission_kind message_id message_version version previous_submission_id snapshot_id content_sha256 input_revision material_versions created_at'),
    'results': ('bb_provider_result_refs', 'id owner_user_id project_id job_id run_id attempt_id logical_call_id attempt_no model_id result_sha256 result_schema_version byte_size created_at'),
    'exec-logs': ('bb_codex_exec_logs', 'attempt_id owner_user_id project_id job_id run_id sha256 byte_size truncated created_at'),
    'credits': ('bb_credit_events', 'id owner_user_id event_key kind points reservation_id lot_id reason_code created_at'),
    'reservations': ('bb_credit_reservations', 'id owner_user_id run_id quote_id points state created_at finalized_at'),
    'billing-rejections': ('bb_billing_request_rejections', 'id owner_user_id project_id run_id operation reason_code error_code created_at'),
    'nodes': ('bb_execution_nodes', 'id account_id region instance_id epoch state pool_tag expected_services source_sha256 image_sha256 created_at updated_at'),
    'sessions': ('bb_execution_node_sessions', 'session_id service_id node_id epoch state native_processes unpersisted_results ready heartbeat_at finished_at'),
    'heartbeats': ('bb_worker_heartbeats', 'worker_id worker_kind worker_version started_at last_seen_at stopped_at active_jobs'),
    'browser-errors': ('bb_browser_error_reports', 'id owner_user_id project_id job_id fingerprint error_type message route_id frontend_version client_time received_at purged_at'),
    'performance-sessions': ('bb_performance_sessions', 'session_id owner_user_id project_id run_id job_id trace_id run_execution_id task_kind service_role worker_instance_id release_sha started_at ended_at last_flush_at closed generated acknowledged dropped invalid_attributes flush_errors last_sequence complete purged_at purged_span_count purge_reason purge_policy_version'),
    'performance-spans': ('bb_performance_spans', 'span_id owner_user_id run_id session_id run_execution_id trace_id job_id parent_span_id stage step_key step_version status started_at ended_at duration_ms last_activity_at clock_source sequence'),
}

# Only diagnostic timing and bounded enum/count attributes cross the reader view.
# Raw attributes can contain future fields that have not been reviewed for export.
PERFORMANCE_ATTRIBUTE_KEYS = (
    'stage', 'wait_reason', 'error_code', 'logical_call_id', 'call_id',
    'model_id', 'model_provider', 'adapter', 'adapter_version',
    'model_config_version', 'cache_status', 'cache_kind', 'cache_reason',
    'tool_type', 'tool_name', 'event_kind', 'result_status', 'operation',
    'outcome', 'measurement_source', 'attempt_no', 'bytes', 'byte_size',
    'bytes_expected', 'bytes_read', 'bytes_written', 'input_bytes',
    'output_bytes', 'input_tokens', 'output_tokens', 'cached_input_tokens',
    'reasoning_tokens', 'retry_count', 'poll_count', 'duration_ms',
    'elapsed_ms', 'first_stdout_ms', 'first_event_ms', 'ttft_ms',
    'timing_complete', 'tool_timing_complete', 'cache_hit', 'reused',
    'tool_observed_start_count', 'tool_measured_count', 'tool_measured_duration_sum_ms',
    'tool_measured_busy_union_ms', 'tool_tracking_overflow_count', 'tool_active_count',
    'tool_aggregate_timing_complete', 'tool_dedup_uncertain',
    'resource_scope', 'resource_availability', 'resource_sample_count', 'resource_sample_error_count',
    'cgroup_cpu_usage_usec', 'cgroup_cpu_throttled_usec', 'cgroup_memory_bytes', 'cgroup_process_count',
    'worker_process_active_codex',
)


def view_name(kind):
    if kind not in SPECS: raise ValueError('Unknown diagnostic collection')
    return kind.replace('-', '_')


def event_view_sql(kind):
    """Keep large event tables' sort/join columns typed and excluded payloads unread."""
    table, fields = SPECS[kind]
    body = 'jsonb_build_object(' + ','.join("'" + f + "',t." + f for f in fields.split()) + ')'
    if kind == 'outbox':
        key, at, attempt = 't.id', 't.created_at', 'NULL::text'
        job = "COALESCE(e.job_id,CASE WHEN t.aggregate_type='job' THEN t.aggregate_id END)"
        run = "COALESCE(j.run_id,e.run_id,CASE WHEN t.aggregate_type='run' THEN t.aggregate_id END)"
        project = 'COALESCE(j.project_id,r.project_id)'
        joins = f"""LEFT JOIN public.bb_observability_events e ON t.aggregate_type='observability' AND e.id=t.aggregate_id
          LEFT JOIN public.bb_jobs j ON j.id={job}
          LEFT JOIN public.bb_runs r ON r.id={run}"""
    elif kind == 'run-events':
        key, at, attempt = "t.id || ':' || t.seq::text", 't.occurred_at', 'NULL::text'
        job, run, project = 'NULL::text', 't.run_id', 'r.project_id'
        joins = 'LEFT JOIN public.bb_runs r ON r.id=t.run_id'
    else:
        assert kind == 'events'
        key, at, attempt = 't.id', 't.created_at', 'NULL::text'
        job, run = 't.job_id', 'COALESCE(t.run_id,j.run_id)'
        project = 'COALESCE(t.project_id,j.project_id,r.project_id)'
        joins = f'LEFT JOIN public.bb_jobs j ON j.id=t.job_id LEFT JOIN public.bb_runs r ON r.id={run}'
    return f'''CREATE OR REPLACE VIEW bb_diagnostics.{view_name(kind)} WITH(security_barrier=true) AS
      SELECT {key} AS key,{at} AS at,t.owner_user_id AS owner_id,{project} AS project_id,
        {run} AS run_id,{job} AS job_id,{attempt} AS attempt_id,{body} AS body
      FROM public.{table} t {joins}'''


def install_sql():
    # This is an administrator installation script, deliberately outside application migrations.
    parts = ["BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';",
             "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bb_diagnostics_reader') THEN CREATE ROLE bb_diagnostics_reader LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4; END IF; END $$;",
             "ALTER ROLE bb_diagnostics_reader NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;",
             "DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='bb_diagnostics_reader')) THEN RAISE EXCEPTION 'Diagnostic role must not inherit other roles'; END IF; END $$;",
             "ALTER ROLE bb_diagnostics_reader SET default_transaction_read_only=on;",
             "ALTER ROLE bb_diagnostics_reader SET statement_timeout='10s';",
             "DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO bb_diagnostics_reader',current_database()); END $$;",
             "CREATE SCHEMA IF NOT EXISTS bb_diagnostics; REVOKE ALL ON SCHEMA bb_diagnostics FROM PUBLIC;",
             "GRANT USAGE ON SCHEMA bb_diagnostics TO bb_diagnostics_reader;",
             "CREATE TABLE IF NOT EXISTS bb_diagnostics.availability(kind text PRIMARY KEY, available boolean NOT NULL);",
             "REVOKE ALL ON bb_diagnostics.availability FROM PUBLIC;"]
    for kind, (table, fields) in SPECS.items():
        view = view_name(kind)
        field_sql = ','.join("'" + f + "'" for f in fields.split())
        key = "COALESCE(d->>'id',d->>'attempt_id',d->>'session_id',d->>'span_id',d->>'worker_id',d->>'run_id',d->>'job_id') || COALESCE(':'||(d->>'seq'),'')"
        owner = "COALESCE(d->>'owner_user_id',j.owner_user_id,r.owner_user_id)"
        if kind == 'users': owner = "d->>'id'"
        attempt = "d->>'id'" if kind == 'attempts' else "d->>'attempt_id'"
        job = "d->>'id'" if kind == 'jobs' else "COALESCE(d->>'job_id',a.job_id)"
        run = "d->>'id'" if kind == 'runs' else "COALESCE(d->>'run_id',j.run_id)"
        extra_join = ''
        if kind == 'outbox':
            extra_join = "LEFT JOIN public.bb_observability_events e ON d->>'aggregate_type'='observability' AND e.id=d->>'aggregate_id'"
            job = "COALESCE(d->>'job_id',a.job_id,e.job_id,CASE WHEN d->>'aggregate_type'='job' THEN d->>'aggregate_id' END)"
            run = "COALESCE(d->>'run_id',j.run_id,e.run_id,CASE WHEN d->>'aggregate_type'='run' THEN d->>'aggregate_id' END)"
        # Fixed whitelist leaves raw snapshot keys and secret-bearing provider payloads out.
        body = f'(SELECT jsonb_object_agg(k,v) FROM jsonb_each(d) item(k,v) WHERE k IN ({field_sql}))'
        if kind == 'performance-spans':
            allowed = ','.join("'" + name + "'" for name in PERFORMANCE_ATTRIBUTE_KEYS)
            body = f"jsonb_set({body}, '{{attributes}}', COALESCE((SELECT jsonb_object_agg(k,v) FROM jsonb_each(COALESCE(d->'attributes','{{}}'::jsonb)) item(k,v) WHERE k IN ({allowed})), '{{}}'::jsonb))"
        sql = f'''CREATE OR REPLACE VIEW bb_diagnostics.{view} WITH(security_barrier=true) AS
          SELECT {key} AS key,
          COALESCE(d->>'created_at',d->>'occurred_at',d->>'observed_at',d->>'recorded_at',d->>'received_at',d->>'started_at','1970-01-01T00:00:00Z')::timestamptz AS at,
          {owner} AS owner_id, COALESCE(d->>'project_id',j.project_id,r.project_id) AS project_id,
          {run} AS run_id,{job} AS job_id,{attempt} AS attempt_id,
          {body} AS body
          FROM (SELECT to_jsonb(t) AS d FROM public.{table} t) src
          {extra_join}
          LEFT JOIN public.bb_model_call_attempts a ON a.id={attempt}
          LEFT JOIN public.bb_jobs j ON j.id={job}
          LEFT JOIN public.bb_runs r ON r.id={run}'''
        if kind in ('outbox', 'run-events', 'events'):
            sql = event_view_sql(kind)
        parts.append(f"DO $install$ BEGIN IF to_regclass('public.{table}') IS NOT NULL THEN EXECUTE $view${sql}$view$; END IF; END $install$;")
        parts.append(f"INSERT INTO bb_diagnostics.availability VALUES('{kind}',to_regclass('public.{table}') IS NOT NULL) ON CONFLICT(kind) DO UPDATE SET available=excluded.available;")
    # Blob references are restricted to active owners/projects and content not purged by policy.
    parts.append('''CREATE OR REPLACE VIEW bb_diagnostics.content_refs WITH(security_barrier=true) AS
      SELECT 'prompt'::text kind,s.id key,s.owner_user_id,s.project_id,s.run_id,NULL::text attempt_id,
        s.object_key,s.content_sha256::text sha256,NULL::bigint byte_size,false capture_truncated
      FROM public.bb_snapshot_refs s JOIN public.bb_users u ON u.id=s.owner_user_id
      JOIN public.bb_projects p ON p.id=s.project_id AND p.owner_user_id=s.owner_user_id
      WHERE u.status='active' AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.bb_log_content_tombstones t WHERE t.content_kind='prompt_snapshot' AND t.content_id=s.id)
      UNION ALL SELECT 'result',s.id,s.owner_user_id,s.project_id,s.run_id,s.attempt_id,s.result_ref,s.result_sha256::text,s.byte_size,false
      FROM public.bb_provider_result_refs s JOIN public.bb_users u ON u.id=s.owner_user_id
      JOIN public.bb_projects p ON p.id=s.project_id AND p.owner_user_id=s.owner_user_id
      WHERE u.status='active' AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.bb_log_content_tombstones t WHERE t.content_kind='provider_result' AND t.content_id=s.id)
      UNION ALL SELECT 'exec',s.attempt_id,s.owner_user_id,s.project_id,s.run_id,s.attempt_id,s.object_key,s.sha256::text,s.byte_size,s.truncated
      FROM public.bb_codex_exec_logs s JOIN public.bb_users u ON u.id=s.owner_user_id
      JOIN public.bb_projects p ON p.id=s.project_id AND p.owner_user_id=s.owner_user_id
      WHERE u.status='active' AND p.deleted_at IS NULL;
      REVOKE ALL ON ALL TABLES IN SCHEMA bb_diagnostics FROM PUBLIC;
      GRANT SELECT ON ALL TABLES IN SCHEMA bb_diagnostics TO bb_diagnostics_reader;
      COMMIT;''')
    return '\n'.join(parts)


class Database:
    def __init__(self, config, run=command):
        self.config, self.run = config, run

    def query(self, sql):
        containers = [v for v in discover(self.config, self.run) if v['service'] == 'postgres' and v['state'] == 'running']
        if len(containers) != 1: raise RuntimeError('A unique active diagnostic database is required')
        name = identifier(self.config.get('database', 'bondbuddy'))
        argv = DOCKER + ['exec', '-i', containers[0]['stream'], 'psql', '-X', '--no-password',
                         '-U', 'bb_diagnostics_reader', '-d', name, '-v', 'ON_ERROR_STOP=1', '-Atq']
        statement = "BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='2s'; " + sql + '; COMMIT;'
        return json.loads(self.run(argv, timeout=18, input_bytes=statement.encode()))

    def available(self):
        return self.query("SELECT COALESCE(json_agg(t),'[]') FROM (SELECT * FROM bb_diagnostics.availability ORDER BY kind) t")

    def page(self, kind, filters, limit=100, cursor=None):
        view = view_name(kind)
        if not 1 <= limit <= 500: raise ValueError('Database page size must be 1..500')
        scope = {'kind': kind, **filters}
        data = cursor_decode(cursor, scope) if cursor else None
        clauses = ['true']; args = {}
        mapping = {'user': 'owner_id', 'project': 'project_id', 'run': 'run_id', 'job': 'job_id', 'attempt': 'attempt_id', 'id': 'key'}
        for key, value in filters.items():
            if key in mapping:
                # key includes run:seq for events, but normal user-supplied IDs never include SQL syntax.
                identifier(value); clauses.append(mapping[key] + "='" + value + "'")
            elif key in ('from', 'to'):
                clauses.append("at" + ('>=' if key == 'from' else '<=') + "'" + timestamp(value) + "'::timestamptz")
            elif key == 'state':
                identifier(value)
                clauses.append("body->>'state'='paused' AND body->>'stage'='provider_reconcile'" if value == 'pending' and kind == 'runs' else "COALESCE(body->>'state',body->>'status',body->>'call_status')='" + value + "'")
            else: raise ValueError('Unknown diagnostic filter')
        ceiling = 'clock_timestamp()'
        if data:
            ceiling = "'" + timestamp(data['ceiling']) + "'::timestamptz"
            last = data['key']
            if not isinstance(last, str) or not re_key(last): raise ValueError('Invalid database cursor key')
            clauses.append("(at,key)>('" + timestamp(data['at']) + "'::timestamptz,'" + last + "')")
        where = ' AND '.join(clauses)
        result = self.query(f'''WITH bound AS (SELECT {ceiling} ceiling), page AS (
          SELECT key,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,owner_id,project_id,run_id,job_id,attempt_id,body
          FROM bb_diagnostics.{view},bound WHERE {where} AND at<=bound.ceiling ORDER BY at,key LIMIT {limit+1})
          SELECT json_build_object('ceiling',to_char(ceiling AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'items',(SELECT COALESCE(json_agg(page),'[]') FROM page)) FROM bound''')
        rows = result['items']; items = rows[:limit]
        next_cursor = cursor_encode({'scope': digest(scope), 'ceiling': result['ceiling'], 'at': items[-1]['at'], 'key': items[-1]['key']}) if len(rows) > limit else None
        return {'items': scrub(items), 'next_cursor': next_cursor, 'consistency': 'fixed creation-time ceiling; mutable status is live'}

    def content_ref(self, kind, key):
        if kind not in ('prompt', 'result', 'exec'): raise ValueError('Unknown content kind')
        identifier(key)
        values = self.query("SELECT COALESCE(json_agg(t),'[]') FROM (SELECT * FROM bb_diagnostics.content_refs WHERE kind='" + kind + "' AND key='" + key + "') t")
        if len(values) != 1: raise ValueError('Content missing, deleted or purged')
        return values[0]


def re_key(value):
    import re
    return len(value) <= 300 and re.fullmatch(r'[A-Za-z0-9_.:-]+', value)


if __name__ == '__main__':
    print(install_sql())
