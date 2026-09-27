import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { STREAM_LIMITS, type StreamEnd } from '@bondbuddy/contracts';
import { date, Problem, run, runDto } from './data.js';
import { currentMaterialParseJob, materialParseJobDto, readMaterialParseJobEvents } from './material-jobs.js';

// #17: server-sent events of persisted state only. Each frame is read back from PostgreSQL
// (bb_run_events / bb_job_events); nothing is pushed from in-memory worker state. The stream
// is read-only: a client disconnect ends the loop and never cancels or pauses the work.
export type StreamSettings = { maxDurationMs?: number; pollMs?: number };
type Deps = { db: () => Pool; owner: (request: FastifyRequest) => Promise<string> };
type Frame = { id?: number; event: string; data: unknown };

const runTerminal = new Set(['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected']);
const jobTerminal = new Set(['succeeded', 'failed', 'cancelled']);

/** Last-Event-ID header wins over ?after=; both must be a non-negative decimal integer. */
export function streamCursor(request: FastifyRequest): number | null {
  const header = request.headers['last-event-id'];
  const raw = typeof header === 'string' && header.length ? header : (request.query as { after?: string } | undefined)?.after;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(raw) || Number(raw) > 2147483647) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid event cursor');
  return Number(raw);
}

const encode = (frame: Frame) => `${frame.id !== undefined ? `id: ${frame.id}\n` : ''}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;

function sse(request: FastifyRequest, settings: StreamSettings, source: {
  snapshot: () => Promise<unknown>;
  page: (after: number) => Promise<{ seq: number; event: string; data: unknown }[]>;
  terminal: () => Promise<boolean>;
}, cursor: number | null) {
  const maxMs = settings.maxDurationMs ?? STREAM_LIMITS.maxDurationMs, pollMs = settings.pollMs ?? STREAM_LIMITS.pollMs;
  let closed = false;
  request.raw.on('close', () => { closed = true; });
  async function* frames() {
    const started = Date.now();
    let last = cursor ?? 0;
    yield `retry: ${STREAM_LIMITS.retryMs}\n\n`;
    if (cursor === null) yield encode({ event: 'snapshot', data: await source.snapshot() });
    let reason: StreamEnd['reason'] = 'max_duration';
    while (!closed) {
      // Terminal is read BEFORE the page, so events committed with the terminal state are always flushed.
      const done = await source.terminal();
      const rows = await source.page(last);
      for (const row of rows) { last = row.seq; yield encode({ id: row.seq, event: row.event, data: row.data }); }
      if (rows.length >= STREAM_LIMITS.pageSize) continue;
      if (done) { reason = 'terminal'; break; }
      if (Date.now() - started >= maxMs) break;
      yield ': keepalive\n\n';
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    if (closed) reason = 'client_closed';
    yield encode({ event: 'stream.end', data: { reason, last_event_id: last || null } satisfies StreamEnd });
  }
  return Readable.from(frames());
}

export function installEventStreams(app: FastifyInstance, deps: Deps, settings: StreamSettings = {}) {
  app.get('/api/v1/runs/:run_id/stream', async (request, reply) => {
    const user = await deps.owner(request), runId = (request.params as { run_id: string }).run_id;
    await run(deps.db(), user, runId); // owner check before parsing the cursor; foreign IDs share 404
    const cursor = streamCursor(request);
    const body = sse(request, settings, {
      snapshot: async () => runDto(await run(deps.db(), user, runId)),
      page: async after => (await deps.db().query('SELECT * FROM bb_run_events WHERE owner_user_id=$1 AND run_id=$2 AND seq>$3 ORDER BY seq LIMIT $4', [user, runId, after, STREAM_LIMITS.pageSize])).rows
        .map(e => ({ seq: Number(e.seq), event: e.type, data: { event_id: e.id, schema_version: 1, trace_id: e.trace_id, run_id: e.run_id, seq: Number(e.seq), occurred_at: date(e.occurred_at), stage: e.stage, type: e.type, state: e.state, payload: e.payload } })),
      terminal: async () => runTerminal.has((await run(deps.db(), user, runId)).state),
    }, cursor);
    return reply.header('content-type', 'text/event-stream; charset=utf-8').header('cache-control', 'private, no-store').header('x-accel-buffering', 'no').send(body);
  });

  app.get('/api/v1/projects/:project_id/materials/:material_id/parse-job/stream', async (request, reply) => {
    const user = await deps.owner(request), params = request.params as { project_id: string; material_id: string };
    const { job } = await currentMaterialParseJob(deps.db(), user, params.project_id, params.material_id);
    const cursor = streamCursor(request);
    const state = async () => (await deps.db().query("SELECT * FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND job_type='parse'", [job.id, user])).rows[0];
    const body = sse(request, settings, {
      snapshot: async () => materialParseJobDto(await state()),
      page: async after => (await readMaterialParseJobEvents(deps.db(), user, job.id, after, STREAM_LIMITS.pageSize)).map(e => ({ seq: e.seq, event: 'job.state_changed', data: e })),
      terminal: async () => jobTerminal.has((await state()).state),
    }, cursor);
    return reply.header('content-type', 'text/event-stream; charset=utf-8').header('cache-control', 'private, no-store').header('x-accel-buffering', 'no').send(body);
  });
}
