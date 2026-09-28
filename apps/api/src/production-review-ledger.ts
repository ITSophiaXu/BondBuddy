import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { productionReviewAttestationSchemas, productionReviewManifestSchemas, validProductionReviewAttestationBinding, type ProductionReviewAttestationEvent,
  type ProductionReviewAttestationSubmitRequest, type ProductionReviewAttestationWithdrawalEvent,
  type ProductionReviewManifest, type ProductionReviewManifestCreateRequest,
  type ProductionReviewWithdrawalCreateRequest } from '@bondbuddy/contracts';
import { productionReviewContentHash, productionReviewContentHashMatches } from '@bondbuddy/rule-pack-registry';
import { Problem } from './data.js';

type Db = () => Pool;
type Actor = (request: FastifyRequest) => Promise<string>;
const uid = () => randomUUID();
const json = (value: unknown) => JSON.stringify(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_PRODUCTION_REVIEW_JSON');
  return encoded;
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function fail(code: string): never {
  if (code === 'FORBIDDEN') throw new Problem(403, 'DATA_NOT_ENTITLED', 'Active production review grant does not cover this scope');
  if (code === 'NOT_FOUND') throw new Problem(404, 'NOT_FOUND', 'Production review record not found');
  if (code.includes('CONFLICT') || code.includes('ALREADY_ATTESTED') || code.includes('SAME_REVIEWER'))
    throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Production review request conflicts with an existing immutable event');
  if (code.includes('HASH_MISMATCH')) throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'The frozen manifest content hash changed');
  if (code.includes('INVALID')) throw new Problem(422, 'VALIDATION_FAILED', 'Production review content or evidence is invalid');
  throw new Problem(503, 'DATA_UNAVAILABLE', 'Production review could not be persisted');
}

async function tx<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function audit(client: PoolClient, actor: string, aggregateId: string, eventType: string, payload: unknown) {
  await client.query(`INSERT INTO bb_production_review_audit(id,actor_user_id,action,aggregate_id,payload)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [uid(), actor, eventType, aggregateId, json(payload)]);
  await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
    VALUES($1,$2,'rule_pack_manifest',$3,$4,$5::jsonb)`, [uid(), actor, aggregateId, eventType, json(payload)]);
}

function manifestDto(row: any): ProductionReviewManifest {
  return { manifest_id: row.manifest_id, manifest_version: row.manifest_version,
    content_sha256: row.content_sha256.trim(), content: row.content };
}
function attestationDto(row: any): ProductionReviewAttestationEvent {
  return { attestation_event_id: row.attestation_event_id, schema_version: 1,
    manifest_id: row.manifest_id, manifest_version: row.manifest_version, content_sha256: row.content_sha256.trim(),
    reviewer_role: row.reviewer_role, reviewer_user_id: row.reviewer_user_id, grant_id: row.grant_id,
    decision: row.decision, reason: row.reason, evidence: row.evidence,
    reviewed_at: new Date(row.reviewed_at).toISOString() } as ProductionReviewAttestationEvent;
}
function withdrawalDto(row: any): ProductionReviewAttestationWithdrawalEvent {
  return { withdrawal_event_id: row.withdrawal_event_id, schema_version: 1,
    attestation_event_id: row.attestation_event_id, withdrawn_by_user_id: row.withdrawn_by_user_id,
    grant_id: row.grant_id, reason: row.reason, withdrawn_at: new Date(row.withdrawn_at).toISOString() };
}

function sortedUnique(values: unknown): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.every((item, index) => typeof item === 'string' && item.length > 0 &&
    (index === 0 || values[index - 1] < item));
}
function nonEmptyUnique(values: unknown): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.every((item, index) => typeof item === 'string' && item.length > 0 &&
    !values.slice(0, index).includes(item));
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function validDimension(value: any, maxItems: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.mode === 'reviewed_unrestricted') return keys === 'evidence_id,evidence_sha256,evidence_version,mode' &&
    idPattern.test(value.evidence_id) && Number.isInteger(value.evidence_version) && value.evidence_version > 0 &&
    value.evidence_version <= 2147483647 && /^[a-f0-9]{64}$/.test(value.evidence_sha256);
  if (value.mode === 'explicit_codes') return keys === 'codes,dictionary_version,mode' && Array.isArray(value.codes) &&
    value.codes.length <= maxItems && sortedUnique(value.codes) && value.codes.every((code: string) => code.length <= 128 && !['all','*'].includes(code.toLowerCase())) &&
    typeof value.dictionary_version === 'string' && value.dictionary_version.length > 0 && value.dictionary_version.length <= 128;
  if (value.mode === 'needs_review') return keys === 'mode,reason,reason_code' && idPattern.test(value.reason_code) &&
    typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 2048;
  return false;
}
function grantCovers(target: any, row: any): boolean {
  if (!sortedUnique(row.instruments) || !nonEmptyUnique(row.document_stages)) return false;
  if (!target.instruments.every((value: string) => row.instruments.includes(value)) ||
      !target.document_stages.every((value: string) => row.document_stages.includes(value))) return false;
  const dimensions = [
    [target.issuer_scopes, row.issuer_scopes, 100], [target.investor_scopes, row.investor_scopes, 100],
    [target.industry_codes, row.industry_codes, 1000], [target.special_feature_scope, row.special_feature_scope, 100],
  ];
  return dimensions.every(([wanted, allowed, maxItems]: any[]) => {
    if (!validDimension(allowed, maxItems) || !validDimension(wanted, maxItems)) return false;
    if (allowed.mode === 'needs_review') return false;
    if (allowed.mode === 'reviewed_unrestricted') return true;
    return wanted.mode === 'explicit_codes' && wanted.dictionary_version === allowed.dictionary_version &&
      wanted.codes.every((code: string) => allowed.codes.includes(code));
  });
}
function scopeHash(row: any): string {
  return sha({ instruments: row.instruments, document_stages: row.document_stages,
    issuer_scopes: row.issuer_scopes, investor_scopes: row.investor_scopes,
    industry_codes: row.industry_codes, special_feature_scope: row.special_feature_scope });
}

async function lockPack(client: PoolClient, packId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rule-pack:'||$1,0))", [packId]);
}
async function currentManifest(client: PoolClient, manifestId: string, version: number, mode: 'SHARE'|'UPDATE'='SHARE') {
  const row = await client.query(`SELECT * FROM bb_production_review_manifests WHERE manifest_id=$1 AND manifest_version=$2 FOR ${mode}`,
    [manifestId, version]);
  if (!row.rows[0]) fail('NOT_FOUND');
  const dto = manifestDto(row.rows[0]);
  if (!productionReviewContentHashMatches(dto)) fail('HASH_MISMATCH');
  return row.rows[0];
}
async function lockEvidenceRows(client: PoolClient, content: any) {
  const pack = content.rule_pack;
  await client.query(`SELECT id FROM bb_rule_pack_production_source_checks WHERE pack_id=$1 AND pack_version=$2 AND pack_hash=$3 ORDER BY id FOR SHARE`,
    [pack.id, pack.version, pack.sha256]);
  await client.query(`SELECT id FROM bb_rule_pack_production_sample_evidence WHERE pack_id=$1 AND pack_version=$2 AND pack_hash=$3 ORDER BY id FOR SHARE`,
    [pack.id, pack.version, pack.sha256]);
}
async function scopedGrant(client: PoolClient, actor: string, role: string, market: string, offering: string,
  applicability: any, lock: 'SHARE'|'UPDATE'='SHARE') {
  const result = await client.query(`SELECT g.id,g.role,g.market,g.offering,s.instruments,s.document_stages,
      s.issuer_scopes,s.investor_scopes,s.industry_codes,s.special_feature_scope,s.scope_hash,u.status
    FROM bb_rule_pack_production_reviewer_grants g
    JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
    JOIN bb_users u ON u.id=g.user_id
    WHERE g.user_id=$1 AND g.role=$2 AND g.market=$3 AND g.offering=$4 AND g.revoked_at IS NULL AND u.status='active'
    ORDER BY g.id FOR ${lock} OF g,s,u`, [actor, role, market, offering]);
  for (const row of result.rows) {
    const actual = scopeHash(row);
    if (actual !== row.scope_hash.trim()) continue;
    if (grantCovers(applicability, row)) return row;
  }
  fail('FORBIDDEN');
}
async function historicalGrantForWithdrawal(client: PoolClient, grantId: string, actor: string, role: string,
  market: string, offering: string, applicability: any) {
  const result = await client.query(`SELECT g.id,g.role,g.market,g.offering,s.instruments,s.document_stages,
      s.issuer_scopes,s.investor_scopes,s.industry_codes,s.special_feature_scope,s.scope_hash,u.status
    FROM bb_rule_pack_production_reviewer_grants g
    JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
    JOIN bb_users u ON u.id=g.user_id
    WHERE g.id=$1 AND g.user_id=$2 AND g.role=$3 AND g.market=$4 AND g.offering=$5 AND u.status='active'
    FOR SHARE OF g,s,u`, [grantId, actor, role, market, offering]);
  const row = result.rows[0];
  if (!row || scopeHash(row) !== row.scope_hash.trim() || !grantCovers(applicability, row)) fail('FORBIDDEN');
  return row;
}

export function installProductionReviewLedgerRoutes(app: FastifyInstance, deps: { db: Db; actor: Actor }) {
  app.post('/api/v1/rule-pack-reviews/manifests', { schema: {
    body: productionReviewAttestationSchemas.ProductionReviewManifestCreateRequest,
    response: { 200: productionReviewManifestSchemas.ProductionReviewManifest },
  } }, async request => {
    const actor = await deps.actor(request), input = request.body as ProductionReviewManifestCreateRequest;
    const packId = input.content.rule_pack.id;
    const manifest = { manifest_id: packId, manifest_version: 1, content_sha256: '0'.repeat(64), content: input.content } as ProductionReviewManifest;
    try { manifest.content_sha256 = productionReviewContentHash(manifest); } catch { fail('INVALID_MANIFEST'); }
    const requestHash = sha({ content: input.content });
    return tx(deps.db(), async client => {
      await lockPack(client, packId);
      const scope = input.content.applicability_scope;
      const latest = await client.query(`SELECT manifest_version FROM bb_production_review_manifests WHERE manifest_id=$1
        ORDER BY manifest_version DESC LIMIT 1 FOR UPDATE`, [packId]);
      const grant = await scopedGrant(client, actor, 'rule_pack_operator', scope.market, scope.offering, scope);
      const replay = await client.query('SELECT * FROM bb_production_review_manifests WHERE manifest_id=$1 AND request_id=$2', [packId, input.request_id]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash.trim() !== requestHash) fail('REQUEST_CONFLICT');
        return manifestDto(replay.rows[0]);
      }
      manifest.manifest_version = Number(latest.rows[0]?.manifest_version ?? 0) + 1;
      manifest.content_sha256 = productionReviewContentHash(manifest);
      await client.query(`INSERT INTO bb_production_review_manifests
        (manifest_id,manifest_version,content_sha256,content,request_id,request_hash,frozen_by_user_id,frozen_by_grant_id)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`, [manifest.manifest_id, manifest.manifest_version,
        manifest.content_sha256, json(manifest.content), input.request_id, requestHash, actor, grant.id]);
      const event = { manifest_id: manifest.manifest_id, manifest_version: manifest.manifest_version,
        content_sha256: manifest.content_sha256, frozen_by_user_id: actor, grant_id: grant.id };
      await audit(client, actor, packId, 'manifest.frozen', event);
      return manifest;
    });
  });

  app.get('/api/v1/rule-pack-reviews/manifests/:manifest_id/versions/:version', { schema: {
    response: { 200: productionReviewManifestSchemas.ProductionReviewManifest },
  } }, async request => {
    const actor = await deps.actor(request), manifestId = (request.params as any).manifest_id;
    const version = Number((request.params as any).version);
    return tx(deps.db(), async client => {
      await lockPack(client, manifestId);
      const row = await currentManifest(client, manifestId, version);
      await scopedGrant(client, actor, 'rule_pack_operator', row.content.applicability_scope.market,
        row.content.applicability_scope.offering, row.content.applicability_scope).catch(async () => {
        const industry = await scopedGrant(client, actor, 'rule_pack_industry_reviewer', row.content.applicability_scope.market,
          row.content.applicability_scope.offering, row.content.applicability_scope).catch(() => null);
        if (!industry) await scopedGrant(client, actor, 'rule_pack_technical_reviewer', row.content.applicability_scope.market,
          row.content.applicability_scope.offering, row.content.applicability_scope);
      });
      return manifestDto(row);
    });
  });

  app.post('/api/v1/rule-pack-reviews/manifests/:manifest_id/versions/:version/attestations', { schema: {
    body: productionReviewAttestationSchemas.ProductionReviewAttestationSubmitRequest,
    response: { 200: productionReviewAttestationSchemas.ProductionReviewAttestationEvent },
  } }, async request => {
    const actor = await deps.actor(request), params = request.params as any;
    const manifestId = params.manifest_id, version = Number(params.version);
    const input = request.body as ProductionReviewAttestationSubmitRequest;
    const role = input.attestation_kind;
    const requestHash = sha(input);
    return tx(deps.db(), async client => {
      await lockPack(client, manifestId);
      const row = await currentManifest(client, manifestId, version);
      if (row.content_sha256.trim() !== input.manifest_content_hash) fail('HASH_MISMATCH');
      const scope = row.content.applicability_scope;
      const grant = await scopedGrant(client, actor, role === 'industry' ? 'rule_pack_industry_reviewer' : 'rule_pack_technical_reviewer',
        scope.market, scope.offering, scope);
      if (row.frozen_by_user_id === actor) fail('SAME_REVIEWER');
      await lockEvidenceRows(client, row.content);
      const boundRequest = { manifest_id: manifestId, manifest_version: version, content_sha256: input.manifest_content_hash,
        decision: input.decision, reason: input.reason, evidence: input.evidence } as any;
      if (!validProductionReviewAttestationBinding(boundRequest, manifestDto(row))) fail('INVALID_EVIDENCE');
      const opposite = role === 'industry' ? 'technical' : 'industry';
      const otherRole = await client.query(`SELECT 1 FROM bb_production_review_attestation_events e
        WHERE e.manifest_id=$1 AND e.manifest_version=$2 AND e.reviewer_role=$3 AND e.reviewer_user_id=$4
        LIMIT 1`, [manifestId, version, opposite, actor]);
      if (otherRole.rowCount) fail('SAME_REVIEWER');
      const replay = await client.query(`SELECT * FROM bb_production_review_attestation_events WHERE manifest_id=$1 AND manifest_version=$2
        AND reviewer_role=$3 AND reviewer_user_id=$4 AND request_id=$5`, [manifestId, version, role, actor, input.request_id]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash.trim() !== requestHash) fail('REQUEST_CONFLICT');
        return attestationDto(replay.rows[0]);
      }
      const existingRole = await client.query(`SELECT g.id,g.role,g.market,g.offering,s.instruments,s.document_stages,
          s.issuer_scopes,s.investor_scopes,s.industry_codes,s.special_feature_scope,s.scope_hash,u.status
        FROM bb_production_review_attestation_events e
        JOIN bb_rule_pack_production_reviewer_grants g ON g.id=e.grant_id AND g.revoked_at IS NULL
        JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
        JOIN bb_users u ON u.id=g.user_id AND u.status='active'
        LEFT JOIN bb_production_review_attestation_withdrawals w ON w.attestation_event_id=e.attestation_event_id
        WHERE e.manifest_id=$1 AND e.manifest_version=$2 AND e.reviewer_role=$3 AND w.attestation_event_id IS NULL
        ORDER BY g.id FOR SHARE OF e,g,s,u`, [manifestId, version, role]);
      if (existingRole.rows.some(existing => scopeHash(existing) === existing.scope_hash.trim() && grantCovers(scope, existing))) fail('ALREADY_ATTESTED');
      const eventId = uid();
      const inserted = await client.query(`INSERT INTO bb_production_review_attestation_events
        (attestation_event_id,manifest_id,manifest_version,content_sha256,request_id,request_hash,reviewer_role,reviewer_user_id,grant_id,decision,reason,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
      [eventId, manifestId, version, input.manifest_content_hash, input.request_id, requestHash, role, actor, grant.id,
        input.decision, input.reason, json(input.evidence)]);
      const dto = attestationDto(inserted.rows[0]);
      await audit(client, actor, manifestId, 'attestation.submitted', dto);
      return dto;
    });
  });

  app.post('/api/v1/rule-pack-reviews/manifests/:manifest_id/versions/:version/attestations/:attestation_event_id/withdrawal', { schema: {
    body: productionReviewAttestationSchemas.ProductionReviewWithdrawalCreateRequest,
    response: { 200: productionReviewAttestationSchemas.ProductionReviewAttestationWithdrawalEvent },
  } }, async request => {
    const actor = await deps.actor(request), params = request.params as any;
    const manifestId = params.manifest_id, version = Number(params.version), eventId = params.attestation_event_id;
    const input = request.body as ProductionReviewWithdrawalCreateRequest, requestHash = sha(input);
    return tx(deps.db(), async client => {
      await lockPack(client, manifestId);
      const manifest = await currentManifest(client, manifestId, version);
      const role = await client.query(`SELECT reviewer_role,reviewer_user_id,grant_id FROM bb_production_review_attestation_events
        WHERE attestation_event_id=$1 AND manifest_id=$2 AND manifest_version=$3`, [eventId, manifestId, version]);
      if (!role.rows[0]) fail('NOT_FOUND');
      if (role.rows[0].reviewer_user_id !== actor) fail('NOT_FOUND');
      const scope = manifest.content.applicability_scope;
      const grant = await historicalGrantForWithdrawal(client, role.rows[0].grant_id, actor,
        role.rows[0].reviewer_role === 'industry' ? 'rule_pack_industry_reviewer' : 'rule_pack_technical_reviewer',
        scope.market, scope.offering, scope);
      await lockEvidenceRows(client, manifest.content);
      const event = await client.query(`SELECT * FROM bb_production_review_attestation_events WHERE attestation_event_id=$1
        AND manifest_id=$2 AND manifest_version=$3 FOR UPDATE`, [eventId, manifestId, version]);
      if (!event.rows[0] || event.rows[0].reviewer_user_id !== actor) fail('NOT_FOUND');
      const replay = await client.query('SELECT * FROM bb_production_review_attestation_withdrawals WHERE attestation_event_id=$1', [eventId]);
      if (replay.rows[0]) {
        if (replay.rows[0].withdrawn_by_user_id !== actor || replay.rows[0].request_id !== input.request_id || replay.rows[0].request_hash.trim() !== requestHash) fail('REQUEST_CONFLICT');
        return withdrawalDto(replay.rows[0]);
      }
      const inserted = await client.query(`INSERT INTO bb_production_review_attestation_withdrawals
        (withdrawal_event_id,attestation_event_id,request_id,request_hash,withdrawn_by_user_id,grant_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [uid(), eventId, input.request_id, requestHash, actor, grant.id, input.reason]);
      const dto = withdrawalDto(inserted.rows[0]);
      await audit(client, actor, manifestId, 'attestation.withdrawn', dto);
      return dto;
    });
  });
}
