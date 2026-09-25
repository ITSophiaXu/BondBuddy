import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { schemas, type OperatorRole } from '@bondbuddy/contracts';
import { missing, Problem, unavailable, type PrivateBlobs } from './data.js';
import { gateState, resumeEvidenceGate } from './evidence-gate.js';
import { adminAlerts, adminEvents, adminJobTimeline, adminMetrics, adminPromptView, correctUsage, operatorRoles, parseAdminFilter } from './log-ops.js';

type Deps = { db: () => Pool; blobs: () => PrivateBlobs; owner: (request: FastifyRequest) => Promise<string> };
const param = (request: FastifyRequest, name: string) => (request.params as Record<string, string>)[name];

// #79 operator routes. Deny by default: without an active grant for the exact role, every
// admin route answers the same owner-safe 404 as an unknown resource.
export function installAdminRoutes(app: FastifyInstance, deps: Deps) {
  async function operator(request: FastifyRequest, role: OperatorRole) {
    const userId = await deps.owner(request);
    if (!(await operatorRoles(deps.db(), userId)).has(role)) throw missing();
    return userId;
  }
  app.get('/api/v1/admin/logs/events', { schema: { response: { 200: schemas.AdminLogEventsResponse } } }, async request => {
    const actor = await operator(request, 'log_reader');
    return adminEvents(deps.db(), actor, parseAdminFilter(request.query as Record<string, unknown>));
  });
  app.get('/api/v1/admin/metrics', { schema: { response: { 200: schemas.AdminMetricsResponse } } }, async request => {
    const actor = await operator(request, 'log_reader');
    return adminMetrics(deps.db(), actor, parseAdminFilter(request.query as Record<string, unknown>));
  });
  app.get('/api/v1/admin/jobs/:job_id/timeline', { schema: { response: { 200: schemas.AdminJobTimelineResponse } } }, async request =>
    adminJobTimeline(deps.db(), await operator(request, 'log_reader'), param(request, 'job_id')));
  app.get('/api/v1/admin/prompts/:snapshot_id', { schema: { response: { 200: schemas.AdminPromptView } } }, async (request, reply) => {
    const actor = await operator(request, 'prompt_viewer');
    const query = request.query as Record<string, unknown>;
    if (Object.keys(query).some(key => key !== 'reason_code') || typeof query.reason_code !== 'string') throw new Problem(422, 'VALIDATION_FAILED', 'reason_code is required');
    reply.header('cache-control', 'no-store');
    let blobs: PrivateBlobs; try { blobs = deps.blobs(); } catch { throw unavailable(); }
    return adminPromptView(deps.db(), blobs, actor, param(request, 'snapshot_id'), query.reason_code);
  });
  app.get('/api/v1/admin/alerts', { schema: { response: { 200: schemas.AdminAlertsResponse } } }, async request => adminAlerts(deps.db(), await operator(request, 'log_reader')));
  app.get('/api/v1/admin/evidence-gate', { schema: { response: { 200: schemas.EvidenceGateResponse } } }, async request => { await operator(request, 'log_reader'); return gateState(deps.db()); });
  app.post('/api/v1/admin/evidence-gate/resume', { schema: { body: schemas.EvidenceGateResumeRequest, response: { 200: schemas.EvidenceGateResponse } } }, async request =>
    resumeEvidenceGate(deps.db(), await operator(request, 'log_operator'), (request.body as { reason_code: string }).reason_code));
  app.post('/api/v1/admin/attempts/:attempt_id/usage-corrections', { schema: { body: schemas.UsageCorrectionRequest, response: { 201: schemas.UsageCorrectionResponse } } }, async (request, reply) => {
    const actor = await operator(request, 'log_operator');
    reply.code(201);
    return correctUsage(deps.db(), actor, param(request, 'attempt_id'), request.body as never);
  });
}
