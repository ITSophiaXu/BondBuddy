import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { FactIdentity } from '@bondbuddy/domain/facts';
import { factIdentityKey } from '@bondbuddy/domain/facts';
import type { FactDecisionRequest } from '@bondbuddy/contracts';
import { schemas } from '@bondbuddy/contracts';
import { missing, Problem, uid } from './data.js';

type ReviewDb = { query: Pool['query']; connect: Pool['connect'] };
type RouteSettings = { db: () => Pool; owner: (request: FastifyRequest) => Promise<string> };
type IdentityInput = FactDecisionRequest['identity'];
const identityHash = (identity: FactIdentity) => createHash('sha256').update(factIdentityKey(identity), 'utf8').digest('hex');
const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact data is invalid'); }
};
const iso = (value: unknown): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact timestamp is invalid');
  return parsed.toISOString();
};
function validDay(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function identityFromRow(value: unknown, owner: string, entityId: unknown, keyHash: unknown): FactIdentity {
  const identity = parseJson(value) as FactIdentity;
  if (!identity || typeof identity !== 'object' || identity.accountId !== owner || typeof identity.entityId !== 'string' ||
    identity.entityId !== entityId || typeof identity.scope !== 'string' || typeof identity.metric !== 'string' ||
    typeof identity.unit !== 'string' || typeof identity.basis !== 'string' || typeof identity.dataVersion !== 'string' ||
    !(identity.currency === null || typeof identity.currency === 'string') || !identity.period || typeof identity.period !== 'object' ||
    Array.isArray(identity.period) || [identity.period.start, identity.period.end, identity.period.asOf].some((value) => value !== undefined && !validDay(value)) ||
    identityHash(identity) !== String(keyHash).trim()) {
    throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact identity is inconsistent');
  }
  return identity;
}
function publicIdentity(identity: FactIdentity) {
  return {
    account_id: identity.accountId,
    entity_id: identity.entityId,
    scope: identity.scope,
    metric: identity.metric,
    period: { start: identity.period.start ?? null, end: identity.period.end ?? null, as_of: identity.period.asOf ?? null },
    currency: identity.currency,
    unit: identity.unit,
    basis: identity.basis,
    data_version: identity.dataVersion,
  };
}
function identityFromInput(input: IdentityInput, owner: string): FactIdentity {
  return {
    accountId: owner,
    entityId: input.entity_id,
    scope: input.scope,
    metric: input.metric,
    period: { ...(input.period.start ? { start: input.period.start } : {}), ...(input.period.end ? { end: input.period.end } : {}), ...(input.period.as_of ? { asOf: input.period.as_of } : {}) },
    currency: input.currency,
    unit: input.unit,
    basis: input.basis,
    dataVersion: input.data_version,
  };
}
function cursorDecode(value: string | undefined): { createdAt: string; id: string } | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' ||
      !Number.isFinite(Date.parse(parsed[0])) || !parsed[1].trim()) throw new Error('cursor');
    return { createdAt: new Date(parsed[0]).toISOString(), id: parsed[1] };
  } catch { throw new Problem(422, 'VALIDATION_FAILED', 'Invalid fact candidate cursor'); }
}
const cursorEncode = (createdAt: string, id: string) => Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
function mapDecision(row: Record<string, unknown>, owner: string, projectId: string) {
  const rawIdentity = identityFromStored(row.fact_key);
  const identity = identityFromRow(row.fact_key, owner, rawIdentity.entityId, row.fact_key_hash);
  if (row.owner_user_id !== owner || row.project_id !== projectId || (row.resolution !== 'selected' && row.resolution !== 'unresolved')) {
    throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact decision scope is inconsistent');
  }
  return { decision_id: String(row.id), version: Number(row.version), resolution: row.resolution,
    selected_candidate_id: row.selected_candidate_id === null ? null : String(row.selected_candidate_id), reason: String(row.reason),
    created_at: iso(row.created_at), identity };
}

async function ensureProject(db: ReviewDb, owner: string, projectId: string): Promise<void> {
  const result = await db.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL', [owner, projectId]);
  if (!result.rows[0]) throw missing();
}

async function listCandidates(db: ReviewDb, owner: string, projectId: string, after: { createdAt: string; id: string } | null, limit: number) {
  const result = await db.query(
    `SELECT c.id,c.owner_user_id,c.project_id,c.entity_id,c.fact_key_hash,c.fact_key,c.value_decimal,c.value_text,c.value_kind,
            c.source_kind,c.source_ref,c.status,c.source_observed_at,c.source_valid_as_of,c.verification_actor_kind,c.verification_actor_id,c.verification_at,c.material_id,c.material_version,
            c.evidence,c.uncertainty,c.created_at,
            d.id AS decision_id,d.owner_user_id AS decision_owner_user_id,d.project_id AS decision_project_id,
            d.fact_key_hash AS decision_fact_key_hash,d.fact_key AS decision_fact_key,d.version AS decision_version,
            d.resolution AS decision_resolution,d.selected_candidate_id AS decision_selected_candidate_id,
            d.reason AS decision_reason,d.created_at AS decision_created_at
       FROM bb_fact_candidates c
       JOIN bb_projects p ON p.owner_user_id=c.owner_user_id AND p.id=c.project_id AND p.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT d.* FROM bb_fact_decisions d
          WHERE d.owner_user_id=c.owner_user_id AND d.project_id=c.project_id AND d.fact_key_hash=c.fact_key_hash
          ORDER BY d.version DESC LIMIT 1
       ) d ON true
      WHERE c.owner_user_id=$1 AND c.project_id=$2
        AND ($3::timestamptz IS NULL OR (c.created_at,c.id)>($3::timestamptz,$4::text))
      ORDER BY c.created_at,c.id LIMIT $5`,
    [owner, projectId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
  );
  const rows = result.rows;
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const items = visible.map((row) => {
    if (row.owner_user_id !== owner || row.project_id !== projectId) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact candidate scope is inconsistent');
    const identity = identityFromRow(row.fact_key, owner, row.entity_id, row.fact_key_hash);
    const evidence = parseJson(row.evidence);
    const uncertainty = parseJson(row.uncertainty);
    if (!Array.isArray(evidence) || !Array.isArray(uncertainty) || !['audited', 'user_statement', 'external'].includes(String(row.source_kind)) ||
      !['extracted', 'verified', 'user_asserted', 'conflicted', 'needs_confirmation', 'superseded'].includes(String(row.status))) {
      throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact candidate is invalid');
    }
    let latestDecision = null;
    if (row.decision_id !== null) {
      const decision = mapDecision({ id: row.decision_id, version: row.decision_version, resolution: row.decision_resolution,
        selected_candidate_id: row.decision_selected_candidate_id, reason: row.decision_reason, created_at: row.decision_created_at,
        owner_user_id: row.decision_owner_user_id, project_id: row.decision_project_id, fact_key: row.decision_fact_key,
        fact_key_hash: row.decision_fact_key_hash }, owner, projectId);
      if (factIdentityKey(decision.identity) !== factIdentityKey(identity)) throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored decision identity is inconsistent');
      latestDecision = { decision_id: decision.decision_id, version: decision.version, resolution: decision.resolution,
        selected_candidate_id: decision.selected_candidate_id, reason: decision.reason, created_at: decision.created_at };
    }
    const value = row.value_kind === 'decimal' ? row.value_decimal : row.value_kind === 'text' ? row.value_text : null;
    return {
      candidate_id: String(row.id), fact_key_hash: String(row.fact_key_hash).trim(), identity: publicIdentity(identity),
      value_kind: row.value_kind, value: value === null ? null : String(value), source_kind: row.source_kind, source_ref: row.source_ref,
      observed_at: row.source_observed_at === null ? null : iso(row.source_observed_at), valid_as_of: row.source_valid_as_of instanceof Date ? row.source_valid_as_of.toISOString().slice(0, 10) : row.source_valid_as_of,
      status: row.status, material_id: row.material_id, material_version: row.material_version === null ? null : Number(row.material_version),
      verification: row.verification_actor_kind === 'internal_reviewer' && typeof row.verification_actor_id === 'string' && row.verification_at !== null
        ? { actor_id: row.verification_actor_id, actor_role: 'internal_reviewer' as const, verified_at: iso(row.verification_at) } : null,
      evidence, uncertainty, created_at: iso(row.created_at), latest_decision: latestDecision,
    };
  });
  const last = visible.at(-1);
  return { items, has_more: hasMore, next_cursor: hasMore && last ? cursorEncode(iso(last.created_at), String(last.id)) : null };
}

async function appendDecision(db: Pool, owner: string, projectId: string, request: FactDecisionRequest) {
  const identity = identityFromInput(request.identity, owner);
  const key = factIdentityKey(identity);
  const keyHash = identityHash(identity);
  const client = await db.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN'); transactionOpen = true;
    const project = await client.query('SELECT 1 FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR KEY SHARE', [owner, projectId]);
    if (!project.rows[0]) throw missing();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fact-decision-request:${owner}:${projectId}:${request.request_id}`]);
    const previous = await client.query(
      `SELECT id,request_id,owner_user_id,project_id,fact_key_hash,fact_key,version,resolution,selected_candidate_id,reason,actor_kind,actor_id,created_at
         FROM bb_fact_decisions WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`, [owner, projectId, request.request_id]);
    if (previous.rows[0]) {
      const row = previous.rows[0]!;
      const previousIdentity = identityFromStored(row.fact_key);
      const oldIdentity = identityFromRow(row.fact_key, owner, previousIdentity.entityId, row.fact_key_hash);
      const matches = row.id === request.decision_id && factIdentityKey(oldIdentity) === key && row.resolution === request.resolution &&
        row.selected_candidate_id === (request.selected_candidate_id ?? null) && row.reason === request.reason && row.actor_id === owner && row.actor_kind === 'user';
      if (!matches) throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Fact decision request id was already used with different content');
      await client.query('COMMIT'); transactionOpen = false;
      return { row, identity: oldIdentity, keyHash: String(row.fact_key_hash).trim(), replayed: true };
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`fact-decision-identity:${owner}:${projectId}:${keyHash}`]);
    const versionResult = await client.query('SELECT COALESCE(max(version),0)::int AS version FROM bb_fact_decisions WHERE owner_user_id=$1 AND project_id=$2 AND fact_key_hash=$3', [owner, projectId, keyHash]);
    const latestVersion = Number(versionResult.rows[0]?.version ?? 0);
    if (request.expected_version !== latestVersion) throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Fact decision changed; reload the latest candidates and review again');
    const version = latestVersion + 1;
    let selectedProvenance: Record<string, unknown> | null = null;
    if (request.resolution === 'selected') {
      if (!request.selected_candidate_id) throw new Problem(422, 'VALIDATION_FAILED', 'selected_candidate_id is required');
      const candidate = await client.query(
        `SELECT id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,source_kind,source_ref,status,source_observed_at,source_valid_as_of,material_id,material_version,created_at
           FROM bb_fact_candidates WHERE owner_user_id=$1 AND project_id=$2 AND id=$3`, [owner, projectId, request.selected_candidate_id]);
      const row = candidate.rows[0];
      if (!row) throw missing();
      const candidateIdentity = identityFromRow(row.fact_key, owner, row.entity_id, row.fact_key_hash);
      if (factIdentityKey(candidateIdentity) !== key) throw new Problem(409, 'FACT_CONFLICT', 'Candidate identity does not match the requested fact identity');
      selectedProvenance = { candidate_id: row.id, source_kind: row.source_kind, source_ref: row.source_ref, status: row.status,
        source_observed_at: row.source_observed_at, source_valid_as_of: row.source_valid_as_of,
        material_id: row.material_id, material_version: row.material_version, candidate_created_at: row.created_at };
    } else {
      if (request.selected_candidate_id !== undefined) throw new Problem(422, 'VALIDATION_FAILED', 'Unresolved decision cannot select a candidate');
      const candidates = await client.query(
        `SELECT entity_id,fact_key_hash,fact_key FROM bb_fact_candidates WHERE owner_user_id=$1 AND project_id=$2 AND fact_key_hash=$3`,
        [owner, projectId, keyHash]);
      if (!candidates.rows.some((row) => factIdentityKey(identityFromRow(row.fact_key, owner, row.entity_id, row.fact_key_hash)) === key)) throw missing();
    }
    const inserted = await client.query(
      `INSERT INTO bb_fact_decisions(id,request_id,owner_user_id,project_id,fact_key_hash,fact_key,version,resolution,selected_candidate_id,selected_candidate_provenance,reason,actor_kind,actor_id)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,'user',$3)
       RETURNING id,request_id,owner_user_id,project_id,fact_key_hash,fact_key,version,resolution,selected_candidate_id,reason,actor_kind,actor_id,created_at`,
      [request.decision_id, request.request_id, owner, projectId, keyHash, JSON.stringify(identity), version, request.resolution,
        request.selected_candidate_id ?? null, selectedProvenance === null ? null : JSON.stringify(selectedProvenance), request.reason]);
    const row = inserted.rows[0];
    if (!row) throw new Problem(503, 'DATA_UNAVAILABLE', 'Fact decision was not stored');
    await client.query('INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,\'fact_decision\',$3,\'fact.decision.appended\',$4::jsonb)',
      [uid(), owner, request.decision_id, JSON.stringify({ decision_id: request.decision_id, project_id: projectId,
        fact_key_hash: keyHash, version, resolution: request.resolution, selected_candidate_id: request.selected_candidate_id ?? null })]);
    await client.query('COMMIT'); transactionOpen = false;
    return { row, identity, keyHash, replayed: false };
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { /* preserve first error */ } }
    throw error;
  } finally { client.release(); }
}

function identityFromStored(value: unknown): FactIdentity {
  const identity = parseJson(value) as FactIdentity;
  if (!identity || typeof identity !== 'object' || typeof identity.entityId !== 'string') throw new Problem(503, 'DATA_UNAVAILABLE', 'Stored fact identity is invalid');
  return identity;
}

function decisionResponse(value: Awaited<ReturnType<typeof appendDecision>>, projectId: string) {
  const row = value.row;
  return { decision_id: String(row.id), request_id: String(row.request_id), project_id: projectId,
    identity: publicIdentity(value.identity), fact_key_hash: value.keyHash, version: Number(row.version), resolution: row.resolution,
    selected_candidate_id: row.selected_candidate_id === null ? null : String(row.selected_candidate_id), reason: String(row.reason),
    actor_kind: 'user' as const, created_at: iso(row.created_at), replayed: value.replayed, verification_effect: 'none' as const };
}

export function installFactReviewRoutes(app: FastifyInstance, settings: RouteSettings) {
  app.get('/api/v1/projects/:project_id/facts/candidates', { schema: { querystring: schemas.FactCandidateListQuery, response: { 200: schemas.FactCandidateListResponse } } }, async (request) => {
    const user = await settings.owner(request), projectId = (request.params as { project_id: string }).project_id;
    const query = request.query as { cursor?: string; limit?: string };
    const after = cursorDecode(query.cursor);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Problem(422, 'VALIDATION_FAILED', 'Invalid fact candidate page size');
    await ensureProject(settings.db(), user, projectId);
    return listCandidates(settings.db(), user, projectId, after, limit);
  });
  app.post('/api/v1/projects/:project_id/facts/decisions', { schema: { body: schemas.FactDecisionRequest, response: { 200: schemas.FactDecisionResponse, 201: schemas.FactDecisionResponse } } }, async (request, reply) => {
    const user = await settings.owner(request), projectId = (request.params as { project_id: string }).project_id;
    await ensureProject(settings.db(), user, projectId);
    const result = await appendDecision(settings.db(), user, projectId, request.body as FactDecisionRequest);
    return reply.code(result.replayed ? 200 : 201).send(decisionResponse(result, projectId));
  });
}
