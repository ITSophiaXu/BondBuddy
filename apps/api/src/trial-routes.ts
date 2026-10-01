import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { schemas, type OperatorRole } from '@bondbuddy/contracts';
import { missing, type PrivateBlobs } from './data.js';
import { operatorRoles } from './log-ops.js';
import { costLedger, createOverride, listOverrides, readiness, readinessOptionsFromEnv, revokeOverride, setKillSwitch, trialStatus, trialUsage, type TrialConfig } from './trial-guard.js';

type Deps = { db: () => Pool; blobs: PrivateBlobs | null; owner: (request: FastifyRequest) => Promise<string>; config: TrialConfig };
const param = (request: FastifyRequest, name: string) => (request.params as Record<string, string>)[name];

// #35 public probes and trial operator routes. Operator routes reuse the #79 grants and answer
// the same owner-safe 404 as an unknown resource without the exact role.
export function installTrialRoutes(app: FastifyInstance, deps: Deps) {
  const probe = readinessOptionsFromEnv();
  app.get('/api/v1/health', { schema: { response: { 200: schemas.LivenessResponse } } }, async () => ({ status: 'ok' as const, service: 'bondbuddy-m1-api' as const }));
  app.get('/api/v1/ready', { schema: { response: { 200: schemas.ReadinessResponse, 503: schemas.ReadinessResponse } } }, async (_request, reply) => {
    let pool: Pool | null = null; try { pool = deps.db(); } catch { /* not configured */ }
    const result = pool ? await readiness(pool, deps.blobs, probe) : { status: 'not_ready' as const, checks: { database: 'failed' as const, blob_storage: 'failed' as const, evidence_gate: 'failed' as const, worker_heartbeat: 'failed' as const }, worker_heartbeat_age_seconds: null, checked_at: new Date().toISOString() };
    reply.header('cache-control', 'no-store');
    return reply.code(result.status === 'ready' ? 200 : 503).send(result);
  });
  async function operator(request: FastifyRequest, role: OperatorRole) {
    const userId = await deps.owner(request);
    if (!(await operatorRoles(deps.db(), userId)).has(role)) throw missing();
    return userId;
  }
  app.get('/api/v1/admin/trial/status', { schema: { response: { 200: schemas.AdminTrialStatusResponse } } }, async request => trialStatus(deps.db(), deps.config, await operator(request, 'log_reader')));
  app.get('/api/v1/admin/trial/usage', { schema: { response: { 200: schemas.AdminTrialUsageResponse } } }, async request => trialUsage(deps.db(), deps.config, await operator(request, 'log_reader'), request.query as Record<string, unknown>));
  app.get('/api/v1/admin/trial/cost-ledger', { schema: { response: { 200: schemas.AdminCostLedgerResponse } } }, async request => costLedger(deps.db(), deps.config, await operator(request, 'log_reader'), request.query as Record<string, unknown>));
  app.get('/api/v1/admin/trial/overrides', { schema: { response: { 200: schemas.TrialOverridesResponse } } }, async request => listOverrides(deps.db(), await operator(request, 'log_reader')));
  app.post('/api/v1/admin/trial/overrides', { schema: { body: schemas.TrialOverrideRequest, response: { 201: schemas.TrialOverrideResponse } } }, async (request, reply) => {
    const actor = await operator(request, 'log_operator');
    reply.code(201);
    return createOverride(deps.db(), actor, request.body as never);
  });
  app.post('/api/v1/admin/trial/overrides/:override_id/revoke', { schema: { body: schemas.TrialOverrideRevokeRequest, response: { 200: schemas.TrialOverrideResponse } } }, async request =>
    revokeOverride(deps.db(), await operator(request, 'log_operator'), param(request, 'override_id'), (request.body as { reason_code: string }).reason_code));
  app.post('/api/v1/admin/trial/kill-switch', { schema: { body: schemas.KillSwitchRequest, response: { 200: schemas.KillSwitchResponse } } }, async request => {
    const actor = await operator(request, 'log_operator');
    const b = request.body as { state: 'engaged' | 'released'; reason_code: string };
    return setKillSwitch(deps.db(), deps.config, actor, b.state, b.reason_code);
  });
}
