// #79/#16 operator-only platform probe. POST /api/v1/admin/probes/model (log_operator) enqueues
// one fixed synthetic template as a platform_probe job owned by the reserved platform principal
// (migration 0027). The worker (apps/worker platform-probe-job) runs it through the contained
// adapter and durable journal; evidence is read with the existing admin job timeline.
// No user id, project or material is accepted, so user data cannot be reached from here.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { PLATFORM_PROBE_JOB_SUBTYPE, PLATFORM_PROBE_JOB_TYPE, PLATFORM_PROBE_TEMPLATE_IDS, platformProbeSchemas, type PlatformProbeRequest, type PlatformProbeResponse, type PlatformProbeTemplateId } from '@bondbuddy/contracts';
import { digest, missing, Problem, transaction, uid } from './data.js';
import { operatorRoles } from './log-ops.js';
import { enqueue } from './queue.js';
import { assertModelCallAllowed, reportTrialRejection, trialGuardConfig, type TrialConfig } from './trial-guard.js';

export type PlatformPrincipal = { user_id: string; project_id: string; input_revision: number; input_hash: string };

export async function platformProbePrincipal(db: Pick<Pool, 'query'>): Promise<PlatformPrincipal> {
  const q = await db.query(`SELECT p.user_id,p.project_id,p.input_revision,r.input_hash FROM bb_platform_principals p
    JOIN bb_input_revisions r ON r.owner_user_id=p.user_id AND r.project_id=p.project_id AND r.revision=p.input_revision
    WHERE p.purpose='platform_probe'`);
  if (!q.rows[0]) throw new Problem(503, 'CAPABILITY_NOT_READY', 'Platform probe principal is not migrated');
  const row = q.rows[0];
  return { user_id: row.user_id, project_id: row.project_id, input_revision: row.input_revision, input_hash: String(row.input_hash).trim() };
}

function response(job: any, run: any, templateId: PlatformProbeTemplateId, replayed: boolean): PlatformProbeResponse {
  return { probe_id: run.id, job_id: job.id, run_id: run.id, trace_id: run.id, job_type: PLATFORM_PROBE_JOB_TYPE, subtype: PLATFORM_PROBE_JOB_SUBTYPE,
    template_id: templateId, state: job.state, replayed, created_at: new Date(job.created_at).toISOString(), timeline_path: `/api/v1/admin/jobs/${job.id}/timeline` };
}

export async function enqueuePlatformProbe(pool: Pool, actorId: string, body: PlatformProbeRequest, config: TrialConfig = trialGuardConfig()): Promise<PlatformProbeResponse> {
  if (!(PLATFORM_PROBE_TEMPLATE_IDS as readonly string[]).includes(body.template_id)) throw new Problem(422, 'VALIDATION_FAILED', 'Unknown probe template');
  const principal = await platformProbePrincipal(pool);
  const executionRequestId = `probe-${body.request_id}`;
  const requestHash = digest(JSON.stringify({ template_id: body.template_id, request_id: body.request_id }));
  return transaction(pool, async client => {
    const prior = (await client.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2', [principal.user_id, executionRequestId])).rows[0];
    if (prior) {
      if (String(prior.request_hash).trim() !== requestHash) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'request_id was used for a different probe');
      const job = (await client.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2', [principal.user_id, prior.id])).rows[0];
      return response(job, prior, body.template_id, true);
    }
    // #35: the kill switch, a deny override and the daily token quota of the platform principal
    // reject a new probe up front; the worker re-checks all of them before the call intent.
    await assertModelCallAllowed(client, config, principal.user_id);
    const run = { id: uid(), owner_user_id: principal.user_id, project_id: principal.project_id, task_kind: PLATFORM_PROBE_JOB_TYPE };
    await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'preparing','preparing')`, [run.id, principal.user_id, principal.project_id, principal.input_revision, principal.input_hash, executionRequestId, PLATFORM_PROBE_JOB_TYPE, requestHash]);
    await enqueue(client, run, PLATFORM_PROBE_JOB_SUBTYPE);
    const job = (await client.query('UPDATE bb_jobs SET checkpoint=$3 WHERE owner_user_id=$1 AND run_id=$2 RETURNING *', [principal.user_id, run.id, { template_id: body.template_id }])).rows[0];
    await client.query('INSERT INTO bb_log_access_audit(id,actor_id,owner_user_id,purpose,filter_hash,actor_role,target_ref,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [uid(), actorId, principal.user_id, 'platform_probe_enqueue', digest(JSON.stringify({ template_id: body.template_id })), 'log_operator', job.id, body.reason_code]);
    return response(job, run, body.template_id, false);
  }).catch(async error => { await reportTrialRejection(pool, error, principal.user_id); throw error; });
}

type Deps = { db: () => Pool; owner: (request: FastifyRequest) => Promise<string>; config: TrialConfig };
export function installPlatformProbeRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/v1/admin/probes/model', { schema: { body: platformProbeSchemas.PlatformProbeRequest, response: { 202: platformProbeSchemas.PlatformProbeResponse } } }, async (request, reply) => {
    const actor = await deps.owner(request);
    if (!(await operatorRoles(deps.db(), actor)).has('log_operator')) throw missing();
    const result = await enqueuePlatformProbe(deps.db(), actor, request.body as PlatformProbeRequest, deps.config);
    return reply.code(202).send(result);
  });
}
