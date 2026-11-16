import { Pool } from 'pg';
const sessionRecord = `session_id text,owner_user_id text,project_id text,run_id text,job_id text,trace_id text,run_execution_id text,task_kind text,service_role text,worker_instance_id text,release_sha text,started_at timestamptz,ended_at timestamptz,last_flush_at timestamptz,closed boolean,generated integer,acknowledged integer,dropped integer,invalid_attributes integer,flush_errors integer,last_sequence integer,complete boolean`;
const spanRecord = `span_id text,owner_user_id text,run_id text,session_id text,run_execution_id text,trace_id text,job_id text,parent_span_id text,stage text,step_key text,step_version integer,status text,started_at timestamptz,ended_at timestamptz,duration_ms double precision,last_activity_at timestamptz,clock_source text,attributes jsonb,span_links jsonb,sequence integer`;
/** Separate pool and transaction: telemetry never holds the caller's run/lease/billing transaction. */
export function createPerformanceBatchWriter(source) {
    const pool = new Pool({ ...source.options, max: 1, min: 0, allowExitOnIdle: true, connectionTimeoutMillis: 500, idleTimeoutMillis: 3000,
        statement_timeout: 1000, query_timeout: 1500, lock_timeout: 250, application_name: 'bondbuddy-performance' });
    // Idle connection failures are advisory too; pg otherwise emits an unhandled error.
    pool.on('error', () => { });
    // pg emits socket errors on a checked-out Client, not the Pool's idle listener.
    // Keep this listener for the entire connection lifetime, including release races;
    // the rejected query still reaches the batch catch and runtime failure counters.
    pool.on('connect', client => client.on('error', () => { }));
    return async (sessions, spans) => {
        const c = await pool.connect();
        try {
            await c.query('BEGIN');
            await persistPerformanceBatch(c, sessions, spans);
            await c.query('COMMIT');
        }
        catch (e) {
            await c.query('ROLLBACK').catch(() => { });
            throw e;
        }
        finally {
            c.release();
        }
    };
}
export async function persistPerformanceBatch(c, sessions, spans) {
    const body = JSON.stringify(sessions);
    const valid = (await c.query(`WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(${sessionRecord}))
 SELECT count(*)::int n FROM incoming x JOIN bb_runs r ON r.id=x.run_id AND r.owner_user_id=x.owner_user_id AND r.project_id=x.project_id
 WHERE x.trace_id=x.run_id AND (x.job_id IS NULL OR EXISTS(SELECT 1 FROM bb_jobs j WHERE j.id=x.job_id AND j.run_id=x.run_id AND j.owner_user_id=x.owner_user_id))`, [body])).rows[0].n;
    if (valid !== sessions.length)
        throw new Error('PERFORMANCE_SCOPE_MISMATCH');
    const inserted = await c.query(`INSERT INTO bb_performance_sessions(session_id,owner_user_id,project_id,run_id,job_id,trace_id,run_execution_id,task_kind,service_role,worker_instance_id,release_sha,started_at,ended_at,last_flush_at,closed,generated,acknowledged,dropped,invalid_attributes,flush_errors,last_sequence,complete)
 SELECT x.session_id,x.owner_user_id,x.project_id,x.run_id,x.job_id,x.trace_id,x.run_execution_id,r.task_kind,x.service_role,x.worker_instance_id,x.release_sha,x.started_at,x.ended_at,x.last_flush_at,x.closed,x.generated,x.acknowledged,x.dropped,x.invalid_attributes,x.flush_errors,x.last_sequence,x.complete
 FROM jsonb_to_recordset($1::jsonb) AS x(${sessionRecord}) JOIN bb_runs r ON r.id=x.run_id AND r.owner_user_id=x.owner_user_id
 ON CONFLICT(session_id) DO UPDATE SET ended_at=EXCLUDED.ended_at,last_flush_at=EXCLUDED.last_flush_at,closed=EXCLUDED.closed,
 generated=EXCLUDED.generated,acknowledged=GREATEST(bb_performance_sessions.acknowledged,EXCLUDED.acknowledged),
 dropped=EXCLUDED.dropped,invalid_attributes=EXCLUDED.invalid_attributes,flush_errors=EXCLUDED.flush_errors,last_sequence=EXCLUDED.last_sequence,complete=EXCLUDED.complete
 WHERE bb_performance_sessions.owner_user_id=EXCLUDED.owner_user_id AND bb_performance_sessions.run_id=EXCLUDED.run_id
 AND bb_performance_sessions.project_id=EXCLUDED.project_id AND bb_performance_sessions.job_id IS NOT DISTINCT FROM EXCLUDED.job_id
 AND bb_performance_sessions.run_execution_id=EXCLUDED.run_execution_id AND bb_performance_sessions.started_at=EXCLUDED.started_at
 AND bb_performance_sessions.last_sequence<=EXCLUDED.last_sequence AND bb_performance_sessions.purged_at IS NULL`, [body]);
    if (inserted.rowCount !== sessions.length)
        throw new Error('PERFORMANCE_SESSION_IDENTITY_CONFLICT');
    if (!spans.length)
        return;
    const payload = JSON.stringify(spans);
    const conflicts = (await c.query(`SELECT count(*)::int n FROM jsonb_to_recordset($1::jsonb) AS x(${spanRecord})
 LEFT JOIN bb_performance_sessions s ON s.session_id=x.session_id AND s.owner_user_id=x.owner_user_id AND s.run_id=x.run_id
 LEFT JOIN bb_performance_spans p ON p.span_id=x.span_id
 LEFT JOIN bb_performance_spans parent ON parent.span_id=x.parent_span_id
 WHERE s.session_id IS NULL OR s.purged_at IS NOT NULL
 OR (parent.span_id IS NOT NULL AND (parent.owner_user_id<>x.owner_user_id OR parent.run_id<>x.run_id OR parent.session_id<>x.session_id))
 OR EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS candidate(${spanRecord}) WHERE candidate.span_id=x.parent_span_id AND (candidate.owner_user_id<>x.owner_user_id OR candidate.run_id<>x.run_id OR candidate.session_id<>x.session_id))
 OR x.trace_id<>s.trace_id OR x.run_execution_id<>s.run_execution_id OR x.job_id IS DISTINCT FROM s.job_id
 OR (p.span_id IS NOT NULL AND (p.owner_user_id<>x.owner_user_id OR p.run_id<>x.run_id OR p.session_id<>x.session_id
 OR p.started_at<>x.started_at OR p.step_key<>x.step_key OR p.parent_span_id IS DISTINCT FROM x.parent_span_id
 OR (p.ended_at IS NOT NULL AND x.ended_at IS NOT NULL AND (p.ended_at<>x.ended_at OR p.status<>x.status OR p.duration_ms<>x.duration_ms))))`, [payload])).rows[0].n;
    if (conflicts)
        throw new Error('PERFORMANCE_SPAN_IDENTITY_CONFLICT');
    await c.query(`INSERT INTO bb_performance_spans(span_id,owner_user_id,run_id,session_id,run_execution_id,trace_id,job_id,parent_span_id,stage,step_key,step_version,status,started_at,ended_at,duration_ms,last_activity_at,clock_source,attributes,span_links,sequence)
 SELECT span_id,owner_user_id,run_id,session_id,run_execution_id,trace_id,job_id,parent_span_id,stage,step_key,step_version,status,started_at,ended_at,duration_ms,last_activity_at,clock_source,attributes,span_links,sequence
 FROM jsonb_to_recordset($1::jsonb) AS x(${spanRecord})
 ON CONFLICT(span_id) DO UPDATE SET status=EXCLUDED.status,ended_at=EXCLUDED.ended_at,duration_ms=EXCLUDED.duration_ms,
 last_activity_at=EXCLUDED.last_activity_at,attributes=EXCLUDED.attributes,span_links=EXCLUDED.span_links,sequence=EXCLUDED.sequence
 WHERE bb_performance_spans.ended_at IS NULL AND bb_performance_spans.sequence<EXCLUDED.sequence`, [payload]);
}
