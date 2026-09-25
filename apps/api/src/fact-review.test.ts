import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { FactIdentity } from '@bondbuddy/domain/facts';
import { factIdentityKey } from '@bondbuddy/domain/facts';
import { createServer } from './server.js';

const origin = 'http://bondbuddy.test';
const connection = process.env.BB_TEST_DATABASE_URL;

test('fact review API scopes candidates and appends idempotent decisions without promoting source status', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const suffix = randomUUID().replaceAll('-', '');
  const ownerAlice = `synthetic-fact-review-alice-${suffix}`;
  const ref = (value: string) => `${value}-${suffix}`;
  let active = ownerAlice;
  const app = createServer({ pool, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown): Promise<any> => app.inject({ method: method as any, url,
    headers: { origin }, ...(payload === undefined ? {} : { payload: payload as any }) });
  const createProject = async (name: string) => {
    const response = await send('POST', '/api/v1/projects', { name, kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  const identity: FactIdentity = { accountId: ownerAlice, entityId: 'issuer-verified-from-source', scope: 'consolidated',
    metric: 'operating_revenue', period: { start: '2024-01-01', end: '2024-12-31' }, currency: 'CNY', unit: 'CNY_10000', basis: 'audited', dataVersion: 'extract-v1' };
  const factHash = createHash('sha256').update(factIdentityKey(identity)).digest('hex');
  const insertCandidate = async (projectId: string, candidateId: string, candidateIdentity: FactIdentity, sourceKind: string,
    status: string, value: string) => {
    const keyHash = createHash('sha256').update(factIdentityKey(candidateIdentity)).digest('hex');
    const evidence = sourceKind === 'audited' ? [{ evidence_id: `evidence-${candidateId}`, material_id: `material-${candidateId}`,
      material_version: 1, content_hash: 'a'.repeat(64), locator_type: 'pdf_page', locator: { page: 2 }, literal_quote: 'OCR 10.0',
      extraction_method: 'ocr', extraction_version: 'ocr-v1', confidence: 0.72, candidate_confidence: 0.72, uncertainty: ['OCR_AMOUNT_UNCONFIRMED'],
      ocr_source: { snapshot_id: `snapshot-${candidateId}`, result_sha256: 'b'.repeat(64), record_id: `record-${candidateId}`, page: 2,
        bbox: [0, 0, 10, 10], page_image_sha256: 'c'.repeat(64), coordinate_system: 'page_pixels' } }] : [];
    await pool.query(`INSERT INTO bb_fact_candidates
      (id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,value_decimal,value_kind,source_kind,source_ref,status,source_observed_at,evidence,uncertainty)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'decimal',$8,$9,$10,'2025-03-01T00:00:00Z',$11::jsonb,$12::jsonb)`,
    [candidateId, candidateIdentity.accountId, projectId, candidateIdentity.entityId, keyHash, JSON.stringify(candidateIdentity), value,
      sourceKind, `source-${candidateId}`, status, JSON.stringify(evidence), JSON.stringify(status === 'needs_confirmation' ? ['OCR_AMOUNT_UNCONFIRMED'] : [])]);
  };
  try {
    const spec = await send('GET', '/openapi.json');
    assert.equal(spec.statusCode, 200);
    assert.ok(spec.json().paths['/api/v1/projects/{project_id}/facts/candidates'].get);
    assert.ok(spec.json().paths['/api/v1/projects/{project_id}/facts/decisions'].post);
    const projectId = await createProject(`Fact review Alice ${suffix}`);
    const otherProjectId = await createProject(`Fact review Alice other project ${suffix}`);
    await insertCandidate(projectId, ref('fr-audited-1'), identity, 'audited', 'needs_confirmation', '100.00');
    await insertCandidate(projectId, ref('fr-user-1'), identity, 'user_statement', 'user_asserted', '120.00');
    await insertCandidate(otherProjectId, ref('fr-other-project'), identity, 'external', 'needs_confirmation', '130.00');
    await insertCandidate(projectId, ref('fr-other-identity'), { ...identity, scope: 'parent_only' }, 'audited', 'needs_confirmation', '100.00');
    await pool.query(`INSERT INTO bb_fact_candidates(id,owner_user_id,project_id,entity_id,fact_key_hash,fact_key,value_kind,source_kind,source_ref,status,source_observed_at)
      VALUES($6,$1,$2,$3,$4,$5::jsonb,'unknown','external','source-fr-no-observed','needs_confirmation',NULL)`,
    [active, projectId, identity.entityId, factHash, JSON.stringify(identity), ref('fr-no-observed')]);

    const list = await send('GET', `/api/v1/projects/${projectId}/facts/candidates?limit=100`);
    assert.equal(list.statusCode, 200, list.body);
    const items = list.json().items as Array<Record<string, unknown>>;
    assert.deepEqual(items.map((item) => item.candidate_id).sort(), [ref('fr-audited-1'), ref('fr-no-observed'), ref('fr-other-identity'), ref('fr-user-1')].sort());
    assert.equal(items.find((item) => item.candidate_id === ref('fr-user-1'))?.source_kind, 'user_statement');
    assert.equal(items.find((item) => item.candidate_id === ref('fr-user-1'))?.status, 'user_asserted');
    const ocr = items.find((item) => item.candidate_id === ref('fr-audited-1'))!;
    assert.equal(ocr.status, 'needs_confirmation');
    assert.equal((ocr.evidence as Array<Record<string, unknown>>)[0]?.extraction_method, 'ocr');
    assert.equal((ocr.evidence as Array<Record<string, unknown>>)[0]?.candidate_confidence, 0.72);
    assert.equal(items.find((item) => item.candidate_id === ref('fr-no-observed'))?.observed_at, null, 'missing observation time remains null');
    assert.equal(ocr.identity && (ocr.identity as Record<string, unknown>).account_id, active);

    const request = { decision_id: ref('fr-decision-1'), request_id: ref('fr-request-1'), identity: {
      entity_id: identity.entityId, scope: identity.scope, metric: identity.metric,
      period: { start: identity.period.start, end: identity.period.end }, currency: identity.currency,
      unit: identity.unit, basis: identity.basis, data_version: identity.dataVersion,
    }, resolution: 'selected', selected_candidate_id: ref('fr-audited-1'), reason: 'Review only; OCR amount still needs confirmation' };
    const created = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, request);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().version, 1);
    assert.equal(created.json().verification_effect, 'none');
    assert.equal(created.json().identity.account_id, active, 'owner identity is server-derived');
    const replay = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, request);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().version, 1);
    const changedReplay = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, { ...request, reason: 'changed' });
    assert.equal(changedReplay.statusCode, 409);
    assert.equal(changedReplay.json().code, 'IDEMPOTENCY_CONFLICT');
    const callerOwner = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, { ...request, request_id: ref('fr-request-owner'), decision_id: ref('fr-decision-owner'), identity: { ...request.identity, account_id: active } });
    assert.equal(callerOwner.statusCode, 422, 'body cannot supply an owner/account identity');

    const mismatch = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, { ...request, request_id: ref('fr-request-wrong-identity'), decision_id: ref('fr-decision-wrong-identity'), selected_candidate_id: ref('fr-other-identity') });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().code, 'FACT_CONFLICT');
    const crossProject = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, { ...request, request_id: ref('fr-request-other-project'), decision_id: ref('fr-decision-other-project'), selected_candidate_id: ref('fr-other-project') });
    assert.equal(crossProject.statusCode, 404);

    const unresolved = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, { ...request, request_id: ref('fr-request-unresolved'), decision_id: ref('fr-decision-unresolved'), resolution: 'unresolved', selected_candidate_id: undefined, reason: 'Evidence conflict remains unresolved' });
    assert.equal(unresolved.statusCode, 201, unresolved.body);
    assert.equal(unresolved.json().version, 2);
    const statuses = await pool.query('SELECT id,status FROM bb_fact_candidates WHERE owner_user_id=$1 AND project_id=$2 ORDER BY id', [active, projectId]);
    assert.deepEqual(statuses.rows.filter((row) => [ref('fr-audited-1'), ref('fr-user-1')].includes(String(row.id))).map((row) => [row.id, row.status]),
      [[ref('fr-audited-1'), 'needs_confirmation'], [ref('fr-user-1'), 'user_asserted']]);

    active = `synthetic-fact-review-bob-${suffix}`;
    const deniedList = await send('GET', `/api/v1/projects/${projectId}/facts/candidates`);
    assert.equal(deniedList.statusCode, 404);
    const deniedDecision = await send('POST', `/api/v1/projects/${projectId}/facts/decisions`, request);
    assert.equal(deniedDecision.statusCode, 404);
    assert.equal(factHash.length, 64);
  } finally { await app.close(); await pool.end(); }
});
