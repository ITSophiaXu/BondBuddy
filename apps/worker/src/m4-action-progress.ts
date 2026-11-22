import { transaction, uid } from '@bondbuddy/api/data';
import type { StageContext } from './run-pipeline.js';

export type M4ProgressReason =
  | 'm4_reading_materials'
  | 'm4_document_working'
  | 'm4_qa_working'
  | 'm4_writing_files'
  | 'm4_registering_artifacts';

/** Publish safe host-observed business phases, never CLI arguments, content or hidden reasoning. */
export async function recordM4Progress(ctx: StageContext, reason: M4ProgressReason) {
  await transaction(ctx.pool, async (client) => {
    const row = (
      await client.query(
        `SELECT event_cursor FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND state='running' FOR UPDATE`,
        [ctx.run.id, ctx.run.owner_user_id],
      )
    ).rows[0];
    if (!row) return;
    const current = (
      await client.query(
        `SELECT 1 FROM bb_jobs WHERE run_id=$1 AND owner_user_id=$2 AND id=$3 AND state='running'
      AND lease_token=$4 AND lease_until>now() FOR UPDATE`,
        [ctx.run.id, ctx.run.owner_user_id, ctx.lease.jobId, ctx.lease.token],
      )
    ).rowCount;
    if (!current) return;
    const seq = Number(row.event_cursor) + 1,
      id = uid(),
      payload = { reason };
    await client.query('UPDATE bb_runs SET event_cursor=$2,updated_at=now() WHERE id=$1', [
      ctx.run.id,
      seq,
    ]);
    await client.query(
      `INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
      VALUES($1,$2,$3,$4,$3,'run.progress','running','model_generation',$5)`,
      [id, ctx.run.owner_user_id, ctx.run.id, seq, payload],
    );
    await client.query(
      `INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'run',$3,'run.progress',$4)`,
      [
        uid(),
        ctx.run.owner_user_id,
        ctx.run.id,
        {
          run_id: ctx.run.id,
          event_id: id,
          seq,
          state: 'running',
          stage: 'model_generation',
          ...payload,
        },
      ],
    );
  });
}

export function m4ActionReason(
  event: Record<string, unknown>,
  kind: 'document' | 'qa',
): M4ProgressReason | null {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return null;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || !['command_execution', 'file_change'].includes(String(item.type))) return null;
  if (
    event.type === 'item.completed' &&
    (item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0))
  )
    return null;
  return item.type === 'file_change'
    ? 'm4_writing_files'
    : kind === 'document'
      ? 'm4_document_working'
      : 'm4_qa_working';
}

export function m4ActionObserver(ctx: StageContext, kind: 'document' | 'qa') {
  let chain = Promise.resolve(),
    last: string | null = null,
    closed = false,
    pending = 0;
  return {
    onEvent(event: Record<string, unknown>) {
      if (closed || ctx.signal.aborted || pending >= 32) return;
      const reason = m4ActionReason(event, kind);
      if (!reason || reason === last) return;
      last = reason;
      pending++;
      chain = chain
        .then(async () => {
          if (!ctx.signal.aborted) await recordM4Progress(ctx, reason);
        })
        .catch(() => {})
        .finally(() => {
          pending--;
        });
    },
    async drain() {
      closed = true;
      await chain;
    },
  };
}
