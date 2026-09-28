import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  productionRulePackReleaseSchemas,
  validProductionReviewAttestationBinding,
  type ProductionReviewAttestationEvent,
  type ProductionReviewManifest,
  type ProductionRulePackReleaseActionRequest,
  type ProductionRulePackReleaseCreateRequest,
  type ProductionRulePackReleaseEvent,
} from '@bondbuddy/contracts';
import {
  publishRulePackBundle,
  withdrawRulePack,
  rulePackContentHash,
  type RulePack,
  type ReviewAttestation,
} from '@bondbuddy/domain';
import {
  productionSnapshotHash,
  productionReviewContentHashMatches,
  readProductionComponentSnapshots,
  type ProductionComponentRefs,
} from '@bondbuddy/rule-pack-registry';
import { Problem } from './data.js';

type Actor = (request: FastifyRequest) => Promise<string>;
type ReleaseRow = Record<string, any>;
const uid = () => randomUUID();
const json = (value: unknown) => JSON.stringify(value);
const HASH = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_PRODUCTION_RELEASE_JSON');
  return encoded;
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const trimHash = (value: unknown) => String(value ?? '').trim();
function dbDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return `${value.getFullYear().toString().padStart(4, '0')}-${(value.getMonth() + 1).toString().padStart(2, '0')}-${value.getDate().toString().padStart(2, '0')}`;
  return String(value).slice(0, 10);
}

function fail(code: string): never {
  if (code === 'FORBIDDEN') throw new Problem(403, 'DATA_NOT_ENTITLED', 'Active production operator grant does not cover this scope');
  if (code === 'NOT_FOUND') throw new Problem(404, 'NOT_FOUND', 'Production release record not found');
  if (code.includes('CONFLICT') || code.includes('CURRENT') || code.includes('TARGET') || code.includes('ALREADY'))
    throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Production release request conflicts with the current immutable event');
  if (code.includes('HASH')) throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Frozen production evidence hash changed');
  if (code.includes('INVALID') || code.includes('INCOMPLETE') || code.includes('EVIDENCE') || code.includes('DATE') || code.includes('SCOPE'))
    throw new Problem(422, 'VALIDATION_FAILED', 'Frozen production evidence is invalid or incomplete');
  throw new Problem(503, 'DATA_UNAVAILABLE', 'Production release could not be persisted');
}

async function tx<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function lockPack(client: PoolClient, packId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rule-pack:'||$1,0))", [packId]);
}

async function activeActor(client: PoolClient, actor: string) {
  const result = await client.query("SELECT id FROM bb_users WHERE id=$1 AND status='active' FOR SHARE", [actor]);
  if (!result.rowCount) fail('FORBIDDEN');
}

function dimensionValid(value: any, maxItems: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.mode === 'reviewed_unrestricted') return keys === 'evidence_id,evidence_sha256,evidence_version,mode' &&
    idPattern.test(value.evidence_id) && Number.isInteger(value.evidence_version) && value.evidence_version > 0 &&
    value.evidence_version <= 2147483647 && HASH.test(value.evidence_sha256);
  if (value.mode === 'explicit_codes') return keys === 'codes,dictionary_version,mode' && Array.isArray(value.codes) &&
    value.codes.length > 0 && value.codes.length <= maxItems && value.codes.every((code: unknown, index: number) =>
      typeof code === 'string' && idPattern.test(code) && (index === 0 || value.codes[index - 1] < code) && !['all','*'].includes(code.toLowerCase())) &&
    typeof value.dictionary_version === 'string' && value.dictionary_version.length > 0 && value.dictionary_version.length <= 128;
  if (value.mode === 'needs_review') return keys === 'mode,reason,reason_code' && idPattern.test(value.reason_code) &&
    typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 2048;
  return false;
}

function scopeHash(row: any): string {
  return sha({ instruments: row.instruments, document_stages: row.document_stages,
    issuer_scopes: row.issuer_scopes, investor_scopes: row.investor_scopes,
    industry_codes: row.industry_codes, special_feature_scope: row.special_feature_scope });
}

function grantCovers(scope: any, grant: any): boolean {
  if (!Array.isArray(grant.instruments) || !Array.isArray(grant.document_stages) ||
      new Set(grant.instruments).size !== grant.instruments.length || new Set(grant.document_stages).size !== grant.document_stages.length ||
      !scope.instruments.every((value: string) => grant.instruments.includes(value)) ||
      !scope.document_stages.every((value: string) => grant.document_stages.includes(value))) return false;
  const dimensions = [
    [scope.issuer_scopes, grant.issuer_scopes, 100], [scope.investor_scopes, grant.investor_scopes, 100],
    [scope.industry_codes, grant.industry_codes, 1000], [scope.special_feature_scope, grant.special_feature_scope, 100],
  ];
  return dimensions.every(([wanted, allowed, maxItems]: any[]) => {
    if (!dimensionValid(wanted, maxItems) || !dimensionValid(allowed, maxItems) || allowed.mode === 'needs_review') return false;
    if (allowed.mode === 'reviewed_unrestricted') return true;
    return wanted.mode === 'explicit_codes' && wanted.dictionary_version === allowed.dictionary_version &&
      wanted.codes.every((code: string) => allowed.codes.includes(code));
  });
}

type GrantRow = {
  id: string; user_id: string; role: string; market: string; offering: string; granted_at: Date | string;
  revoked_at: Date | string | null; instruments: string[]; document_stages: string[];
  issuer_scopes: any; investor_scopes: any; industry_codes: any; special_feature_scope: any; scope_hash: string; status: string;
};

async function scopedGrant(client: PoolClient, actor: string, role: string, scope: any, mode: 'SHARE' | 'UPDATE' | 'NONE' = 'SHARE'): Promise<GrantRow> {
  const lockClause = mode === 'NONE' ? '' : `FOR ${mode} OF g,s,u`;
  const result = await client.query<GrantRow>(`SELECT g.id,g.user_id,g.role,g.market,g.offering,g.granted_at,g.revoked_at,
      s.instruments,s.document_stages,s.issuer_scopes,s.investor_scopes,s.industry_codes,s.special_feature_scope,s.scope_hash,u.status
    FROM bb_rule_pack_production_reviewer_grants g
    JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
    JOIN bb_users u ON u.id=g.user_id
    WHERE g.user_id=$1 AND g.role=$2 AND g.market=$3 AND g.offering=$4 AND g.revoked_at IS NULL AND u.status='active'
    ORDER BY g.id ${lockClause}`, [actor, role, scope.market, scope.offering]);
  for (const row of result.rows) {
    if (scopeHash(row) === trimHash(row.scope_hash) && grantCovers(scope, row)) return row;
  }
  fail('FORBIDDEN');
}

async function freezeRow(client: PoolClient, input: Pick<ProductionRulePackReleaseCreateRequest, 'manifest_id' | 'manifest_version'>,
  mode: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<ProductionReviewManifest> {
  const result = await client.query(`SELECT manifest_id,manifest_version,content_sha256,content
    FROM bb_production_review_manifests WHERE manifest_id=$1 AND manifest_version=$2 FOR ${mode}`,
  [input.manifest_id, input.manifest_version]);
  const row = result.rows[0];
  if (!row) fail('NOT_FOUND');
  const manifest = { manifest_id: row.manifest_id, manifest_version: row.manifest_version,
    content_sha256: trimHash(row.content_sha256), content: row.content } as ProductionReviewManifest;
  if (!productionReviewContentHashMatches(manifest)) fail('MANIFEST_HASH_MISMATCH');
  return manifest;
}

function refsFromManifest(manifest: ProductionReviewManifest): ProductionComponentRefs {
  const content = manifest.content;
  return {
    rule_pack: { kind: 'rule_pack', ...content.rule_pack },
    chapter_template: { kind: 'chapter_template', ...content.chapter_template },
    coverage_manifest: { kind: 'coverage_manifest', ...content.coverage_manifest },
  };
}

function assertSnapshotMatchesManifest(manifest: ProductionReviewManifest, snapshots: Awaited<ReturnType<typeof readProductionComponentSnapshots>>) {
  const scope = manifest.content.applicability_scope, pack = snapshots.rule_pack;
  if (manifest.manifest_id !== pack.pack_id || pack.version !== manifest.content.rule_pack.version ||
      rulePackContentHash(pack) !== manifest.content.rule_pack.sha256 ||
      productionSnapshotHash(snapshots.chapter_template) !== manifest.content.chapter_template.sha256 ||
      productionSnapshotHash(snapshots.coverage_manifest) !== manifest.content.coverage_manifest.sha256 ||
      scope.market !== pack.scope.market || scope.offering !== pack.scope.offering ||
      JSON.stringify([...scope.instruments].sort()) !== JSON.stringify([...pack.scope.instruments].sort()) ||
      JSON.stringify([...scope.document_stages].sort()) !== JSON.stringify([...pack.scope.document_stages].sort()) ||
      scope.applicable_from !== pack.validity.effective_from || scope.applicable_until !== pack.validity.effective_to)
    fail('PRODUCTION_COMPONENT_MANIFEST_MISMATCH');
}

type Approval = { event: ProductionReviewAttestationEvent; grant_id: string; grant: GrantRow };

async function approvedAttestations(client: PoolClient, actor: string, manifest: ProductionReviewManifest,
  operatorGrant: GrantRow, packId: string): Promise<{ industry: Approval; technical: Approval }> {
  const reviewers = await client.query(`SELECT e.*,g.user_id,g.role AS grant_role,g.market,g.offering,g.granted_at,g.revoked_at,
      s.instruments,s.document_stages,s.issuer_scopes,s.investor_scopes,s.industry_codes,s.special_feature_scope,s.scope_hash,u.status
    FROM bb_production_review_attestation_events e
    JOIN bb_rule_pack_production_reviewer_grants g ON g.id=e.grant_id
    JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
    JOIN bb_users u ON u.id=g.user_id
    LEFT JOIN bb_production_review_attestation_withdrawals w ON w.attestation_event_id=e.attestation_event_id
    WHERE e.manifest_id=$1 AND e.manifest_version=$2 AND e.content_sha256=$3 AND e.decision='approve'
      AND w.attestation_event_id IS NULL
    ORDER BY g.id`, [manifest.manifest_id, manifest.manifest_version, manifest.content_sha256]);
  // Lock grant/scope/user rows in the globally agreed grant-id order before evidence rows.
  const grantIds = [...new Set([operatorGrant.id, ...reviewers.rows.map(row => String(row.grant_id))])].sort();
  const lockedGrants = grantIds.length ? await client.query(`SELECT g.id,g.user_id,g.role,g.market,g.offering,g.granted_at,g.revoked_at,
      s.instruments,s.document_stages,s.issuer_scopes,s.investor_scopes,s.industry_codes,s.special_feature_scope,s.scope_hash,u.status
    FROM bb_rule_pack_production_reviewer_grants g
    JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id JOIN bb_users u ON u.id=g.user_id
    WHERE g.id=ANY($1::text[]) ORDER BY g.id FOR SHARE OF g,s,u`, [grantIds]) : { rows: [] as GrantRow[] };
  const grantById = new Map(lockedGrants.rows.map(row => [row.id, row]));
  const lockedOperator = grantById.get(operatorGrant.id);
  if (!lockedOperator || lockedOperator.user_id !== actor || lockedOperator.role !== 'rule_pack_operator' ||
      lockedOperator.revoked_at !== null || lockedOperator.status !== 'active' ||
      scopeHash(lockedOperator) !== trimHash(lockedOperator.scope_hash) || !grantCovers(manifest.content.applicability_scope, lockedOperator))
    fail('FORBIDDEN');

  const scope = manifest.content.applicability_scope;
  const active = reviewers.rows.filter(row => row.status === 'active' && row.revoked_at === null && row.granted_at <= new Date() &&
    row.market === scope.market && row.offering === scope.offering && scopeHash(row) === trimHash(row.scope_hash) &&
    grantCovers(scope, row) && row.reviewer_user_id !== actor && row.grant_role ===
      (row.reviewer_role === 'industry' ? 'rule_pack_industry_reviewer' : 'rule_pack_technical_reviewer'));
  const toApproval = (row: any): Approval => ({ event: {
    attestation_event_id: row.attestation_event_id, schema_version: 1, manifest_id: row.manifest_id,
    manifest_version: row.manifest_version, content_sha256: trimHash(row.content_sha256),
    reviewer_role: row.reviewer_role, reviewer_user_id: row.reviewer_user_id, grant_id: row.grant_id,
    decision: row.decision, reason: row.reason, evidence: row.evidence,
    reviewed_at: new Date(row.reviewed_at).toISOString(),
  } as ProductionReviewAttestationEvent, grant_id: row.grant_id, grant: row as GrantRow });
  const industryRows = active.filter(row => row.reviewer_role === 'industry');
  const technicalRows = active.filter(row => row.reviewer_role === 'technical');
  if (!industryRows.length || !technicalRows.length) fail('INCOMPLETE_ACTIVE_APPROVALS');
  // Each role has one live, scope-covering attestation; ambiguity fails closed.
  const industry = toApproval(industryRows[0]);
  const technical = toApproval(technicalRows[0]);
  if (industryRows.length !== 1 || technicalRows.length !== 1 ||
      industry.event.reviewer_user_id === technical.event.reviewer_user_id ||
      industry.event.reviewer_user_id === actor || technical.event.reviewer_user_id === actor) fail('INCOMPLETE_ACTIVE_APPROVALS');
  if (!validProductionReviewAttestationBinding({ manifest_id: manifest.manifest_id,
      manifest_version: manifest.manifest_version, content_sha256: manifest.content_sha256,
      decision: industry.event.decision, reason: industry.event.reason, evidence: industry.event.evidence } as any, manifest) ||
      !validProductionReviewAttestationBinding({ manifest_id: manifest.manifest_id,
      manifest_version: manifest.manifest_version, content_sha256: manifest.content_sha256,
      decision: technical.event.decision, reason: technical.event.reason, evidence: technical.event.evidence } as any, manifest))
    fail('INVALID_APPROVAL_EVIDENCE');
  return { industry, technical };
}

async function lockApprovalEvents(client: PoolClient, approvals: { industry: Approval; technical: Approval }) {
  const eventIds = [approvals.industry.event.attestation_event_id, approvals.technical.event.attestation_event_id].sort();
  const locked = await client.query(`SELECT attestation_event_id FROM bb_production_review_attestation_events
    WHERE attestation_event_id=ANY($1::text[]) ORDER BY attestation_event_id FOR SHARE`, [eventIds]);
  if (locked.rowCount !== 2) fail('INCOMPLETE_ACTIVE_APPROVALS');
}

async function lockAndValidateEvidence(client: PoolClient, manifest: ProductionReviewManifest) {
  const packRef = manifest.content.rule_pack;
  const sources = manifest.content.source_date_evidence;
  const samples = manifest.content.authorized_real_sample_evidence;
  const sourceIds = sources.map(row => row.source_evidence_id).sort();
  const sampleIds = samples.map(row => row.sample_evidence_id).sort();
  const authorizationIds = [...new Set(samples.map(row => row.authorization_evidence_id))].sort();
  const sourceResult = await client.query(`SELECT * FROM bb_rule_pack_production_source_checks
    WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, [sourceIds]);
  const authorizationResult = await client.query(`SELECT * FROM bb_rule_pack_sample_authorizations
    WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, [authorizationIds]);
  const sampleResult = await client.query(`SELECT * FROM bb_rule_pack_production_sample_evidence
    WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, [sampleIds]);
  if (sourceResult.rowCount !== sourceIds.length || sampleResult.rowCount !== sampleIds.length ||
      authorizationResult.rowCount !== authorizationIds.length) fail('PRODUCTION_EVIDENCE_NOT_FOUND');
  const sourceById = new Map(sourceResult.rows.map(row => [row.id, row]));
  const authById = new Map(authorizationResult.rows.map(row => [row.id, row]));
  const sampleById = new Map(sampleResult.rows.map(row => [row.id, row]));
  const now = new Date(), today = now.toISOString().slice(0, 10);
  for (const source of sources) {
    const row = sourceById.get(source.source_evidence_id);
    if (!row || trimHash(row.source_check_sha256) !== source.source_check_sha256 ||
        row.pack_id !== packRef.id || row.pack_version !== packRef.version || trimHash(row.pack_hash) !== packRef.sha256 ||
        row.market !== manifest.content.applicability_scope.market || row.offering !== manifest.content.applicability_scope.offering ||
        !row.checked_at || new Date(row.checked_at) > now || !row.effective_from || dbDate(row.effective_from)! > today ||
        (row.effective_to && dbDate(row.effective_to)! < today) ||
        source.legal_effective_date && dbDate(row.effective_from) !== source.legal_effective_date ||
        source.legal_expiry_date && dbDate(row.effective_to) !== source.legal_expiry_date)
      fail('PRODUCTION_SOURCE_EVIDENCE_MISMATCH');
  }
  for (const sample of samples) {
    const row = sampleById.get(sample.sample_evidence_id), auth = authById.get(sample.authorization_evidence_id);
    if (!row || !auth || trimHash(row.sample_evidence_sha256) !== sample.sample_evidence_sha256 ||
        trimHash(row.expected_outcome_sha256) !== sample.expected_outcome_sha256 ||
        trimHash(row.reviewed_result_sha256) !== sample.reviewed_result_sha256 ||
        trimHash(auth.authorization_evidence_sha256) !== sample.authorization_evidence_sha256 ||
        row.sample_case_id !== sample.sample_case_id || row.polarity !== sample.polarity ||
        row.pack_id !== packRef.id || row.pack_version !== packRef.version || trimHash(row.pack_hash) !== packRef.sha256 ||
        row.authorization_id !== sample.authorization_evidence_id || auth.revoked_at !== null ||
        auth.authorization_scope !== 'rule_pack_validation' || auth.market !== manifest.content.applicability_scope.market ||
        auth.offering !== manifest.content.applicability_scope.offering || new Date(auth.authorized_at) > now ||
        row.expected_outcome !== row.observed_outcome || new Date(row.reviewed_at) > now)
      fail('PRODUCTION_SAMPLE_EVIDENCE_MISMATCH');
  }
  return { sourceIds, sampleIds };
}

function eventDto(row: ReleaseRow): ProductionRulePackReleaseEvent {
  return {
    id: row.id, pack_id: row.pack_id, request_id: row.request_id, sequence: row.sequence, action: row.action,
    pack_version: row.pack_version, content_hash: trimHash(row.content_hash), target_event_id: row.target_event_id,
    manifest_id: row.manifest_id ?? null, manifest_version: row.manifest_version ?? null,
    manifest_content_sha256: row.manifest_content_sha256 ? trimHash(row.manifest_content_sha256) : null,
    industry_attestation_event_id: row.industry_attestation_event_id ?? null,
    technical_attestation_event_id: row.technical_attestation_event_id ?? null,
    operator_user_id: row.operator_user_id, operator_grant_id: row.operator_grant_id,
    reason: row.reason, occurred_at: new Date(row.occurred_at).toISOString(),
  };
}

async function replay(client: PoolClient, packId: string, requestId: string, requestHash: string, actor: string) {
  const result = await client.query(`SELECT * FROM bb_rule_pack_production_release_events WHERE pack_id=$1 AND request_id=$2`, [packId, requestId]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.operator_user_id !== actor || trimHash(row.request_hash) !== requestHash) fail('REQUEST_CONFLICT');
  return eventDto(row);
}

async function latestEvent(client: PoolClient, packId: string) {
  const result = await client.query(`SELECT * FROM bb_rule_pack_production_release_events
    WHERE pack_id=$1 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [packId]);
  return result.rows[0] as ReleaseRow | undefined;
}

async function latestEventPeek(client: PoolClient, packId: string) {
  const result = await client.query(`SELECT * FROM bb_rule_pack_production_release_events
    WHERE pack_id=$1 ORDER BY sequence DESC LIMIT 1`, [packId]);
  return result.rows[0] as ReleaseRow | undefined;
}

async function lockEvidenceOnly(client: PoolClient, manifest: ProductionReviewManifest) {
  const pack = manifest.content.rule_pack;
  await client.query(`SELECT id FROM bb_rule_pack_production_source_checks
    WHERE pack_id=$1 AND pack_version=$2 AND pack_hash=$3 ORDER BY id FOR SHARE`, [pack.id, pack.version, pack.sha256]);
  await client.query(`SELECT id FROM bb_rule_pack_sample_authorizations WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`,
    [[...new Set(manifest.content.authorized_real_sample_evidence.map(row => row.authorization_evidence_id))].sort()]);
  await client.query(`SELECT id FROM bb_rule_pack_production_sample_evidence
    WHERE pack_id=$1 AND pack_version=$2 AND pack_hash=$3 ORDER BY id FOR SHARE`, [pack.id, pack.version, pack.sha256]);
}

async function appendActorAudit(client: PoolClient, actor: string, event: ReleaseRow, action: string,
  grant: GrantRow, industry?: Approval, technical?: Approval) {
  const payload = { event_id: event.id, pack_id: event.pack_id, manifest_id: event.manifest_id,
    manifest_version: event.manifest_version, manifest_content_sha256: event.manifest_content_sha256,
    operator_grant_id: grant.id, industry_grant_id: industry?.grant_id ?? null,
    industry_attestation_event_id: event.industry_attestation_event_id ?? null,
    technical_grant_id: technical?.grant_id ?? null,
    technical_attestation_event_id: event.technical_attestation_event_id ?? null,
    target_event_id: event.target_event_id, action };
  await client.query(`INSERT INTO bb_rule_pack_production_release_audit
    (id,event_id,actor_user_id,action,manifest_id,manifest_version,manifest_content_sha256,
      operator_grant_id,industry_grant_id,technical_grant_id,payload,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`, [uid(), event.id, actor, action,
    event.manifest_id, event.manifest_version, event.manifest_content_sha256, grant.id,
    industry?.grant_id ?? null, technical?.grant_id ?? null, json(payload), event.occurred_at]);
  const outbox = await client.query(`SELECT owner_user_id,aggregate_type,event_type,payload
    FROM bb_outbox WHERE id=$1 FOR SHARE`, [`rule-pack-prod-${event.id}`]);
  if (outbox.rowCount !== 1 || outbox.rows[0].owner_user_id !== actor ||
      outbox.rows[0].aggregate_type !== 'rule_pack_release' || outbox.rows[0].event_type !== `rule_pack.${action}`)
    fail('ACTOR_OUTBOX_NOT_WRITTEN');
}

function scopeForEvent(row: ReleaseRow) {
  return { market: row.market, offering: row.offering,
    instruments: row.instruments, document_stages: row.document_stages,
    issuer_scopes: { mode: 'reviewed_unrestricted', evidence_id: 'legacy-release-scope', evidence_version: 1, evidence_sha256: '0'.repeat(64) },
    investor_scopes: { mode: 'reviewed_unrestricted', evidence_id: 'legacy-release-scope', evidence_version: 1, evidence_sha256: '0'.repeat(64) },
    industry_codes: { mode: 'reviewed_unrestricted', evidence_id: 'legacy-release-scope', evidence_version: 1, evidence_sha256: '0'.repeat(64) },
    special_feature_scope: { mode: 'reviewed_unrestricted', evidence_id: 'legacy-release-scope', evidence_version: 1, evidence_sha256: '0'.repeat(64) } };
}

async function manifestForEvent(client: PoolClient, row: ReleaseRow) {
  if (!row.manifest_id || !row.manifest_version || !row.manifest_content_sha256) fail('NOT_FOUND');
  const manifest = await freezeRow(client, { manifest_id: row.manifest_id, manifest_version: row.manifest_version });
  if (manifest.content_sha256 !== trimHash(row.manifest_content_sha256)) fail('MANIFEST_HASH_MISMATCH');
  return manifest;
}

export function installProductionRulePackReleaseRoutes(app: FastifyInstance, deps: { db: () => Pool; actor: Actor }) {
  app.post('/api/v1/rule-pack-releases', { schema: {
    body: productionRulePackReleaseSchemas.ProductionRulePackReleaseCreateRequest,
    response: { 200: productionRulePackReleaseSchemas.ProductionRulePackReleaseEvent },
  } }, async request => {
    const actor = await deps.actor(request), input = request.body as ProductionRulePackReleaseCreateRequest;
    const requestHash = sha({ action: 'production_release', actor, ...input });
    return tx(deps.db(), async client => {
      const packId = input.manifest_id;
      await lockPack(client, packId);
      const prior = await replay(client, packId, input.request_id, requestHash, actor);
      if (prior) return prior;
      const manifest = await freezeRow(client, input);
      if (manifest.content_sha256 !== input.manifest_content_hash) fail('MANIFEST_HASH_MISMATCH');
      const scope = manifest.content.applicability_scope;
      await activeActor(client, actor);
      const operator = await scopedGrant(client, actor, 'rule_pack_operator', scope, 'NONE');
      if (scope.uncovered_items.length) fail('PRODUCTION_SCOPE_INCOMPLETE');
      const components = await readProductionComponentSnapshots(client as any, refsFromManifest(manifest));
      assertSnapshotMatchesManifest(manifest, components);
      const approvals = await approvedAttestations(client, actor, manifest, operator, packId);
      const evidence = await lockAndValidateEvidence(client, manifest);
      await lockApprovalEvents(client, approvals);
      const occurredAt = new Date().toISOString();
      const reviews: ReviewAttestation[] = [approvals.industry, approvals.technical].map(({ event }) => ({
        reviewer_id: event.reviewer_user_id,
        reviewer_role: event.reviewer_role === 'industry' ? 'industry_reviewer' : 'technical_reviewer',
        reviewed_at: event.reviewed_at,
        source_verified: true,
        scope_verified: true,
        samples_verified: true,
        notes: `Approved frozen manifest ${manifest.manifest_id}@${manifest.manifest_version}#${manifest.content_sha256}`,
      }));
      let published: RulePack;
      try { published = publishRulePackBundle(components.rule_pack, components.chapter_template, components.coverage_manifest, {
        channel: 'production', reviews, released_by: actor, released_at: occurredAt, reason: input.reason,
      }); } catch { fail('INVALID_PRODUCTION_COMPONENT_SNAPSHOT'); }
      if (published.release?.content_hash !== manifest.content.rule_pack.sha256 ||
          published.version !== manifest.content.rule_pack.version) fail('PRODUCTION_COMPONENT_HASH_MISMATCH');

      // Event lock follows the same final step of Felix's sequence.
      const latest = await latestEvent(client, packId);
      const sequence = (latest?.sequence ?? 0) + 1;
      const id = uid();
      const inserted = await client.query(`INSERT INTO bb_rule_pack_production_release_events
        (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
         coverage_version,coverage_hash,target_event_id,market,offering,instruments,document_stages,effective_from,effective_to,
         pack_snapshot,template_snapshot,coverage_snapshot,source_check_ids,sample_evidence_ids,operator_user_id,operator_grant_id,
         industry_reviewer_user_id,industry_reviewer_grant_id,technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at,
         manifest_id,manifest_version,manifest_content_sha256,industry_attestation_event_id,technical_attestation_event_id)
        VALUES($1,$2,$3,$4,$5,'production_release',$6,$7,$8,$9,$10,$11,NULL,$12,$13,$14::text[],$15::text[],$16,$17,
         $18::jsonb,$19::jsonb,$20::jsonb,$21::text[],$22::text[],$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)
        RETURNING *`, [id, packId, input.request_id, requestHash, sequence, published.version, published.release!.content_hash,
        components.chapter_template.version, productionSnapshotHash(components.chapter_template),
        components.coverage_manifest.version, productionSnapshotHash(components.coverage_manifest), scope.market, scope.offering,
        published.scope.instruments, published.scope.document_stages, published.validity.effective_from, published.validity.effective_to,
        json(published), json(components.chapter_template), json(components.coverage_manifest), evidence.sourceIds, evidence.sampleIds,
        actor, operator.id, approvals.industry.event.reviewer_user_id, approvals.industry.grant_id,
        approvals.technical.event.reviewer_user_id, approvals.technical.grant_id, input.reason, occurredAt,
        manifest.manifest_id, manifest.manifest_version, manifest.content_sha256,
        approvals.industry.event.attestation_event_id, approvals.technical.event.attestation_event_id]);
      const row = inserted.rows[0];
      await appendActorAudit(client, actor, row, 'production_release', operator, approvals.industry, approvals.technical);
      return eventDto(row);
    });
  });

  app.post('/api/v1/rule-pack-releases/:pack_id/withdrawals', { schema: {
    body: productionRulePackReleaseSchemas.ProductionRulePackReleaseActionRequest,
    response: { 200: productionRulePackReleaseSchemas.ProductionRulePackReleaseEvent },
  } }, async request => {
    const actor = await deps.actor(request), packId = (request.params as any).pack_id as string;
    const input = request.body as ProductionRulePackReleaseActionRequest;
    const requestHash = sha({ action: 'production_withdrawal', actor, pack_id: packId, ...input });
    return tx(deps.db(), async client => {
      await lockPack(client, packId);
      const priorReplay = await replay(client, packId, input.request_id, requestHash, actor);
      if (priorReplay) return priorReplay;
      await activeActor(client, actor);
      const latestRead = await latestEventPeek(client, packId);
      const latest = latestRead;
      if (!latest || latest.id !== input.target_event_id || !['production_release','production_rollback'].includes(latest.action)) fail('CURRENT_EVENT_REQUIRED');
      const manifest = await manifestForEvent(client, latest);
      const scope = manifest.content.applicability_scope;
      const operator = await scopedGrant(client, actor, 'rule_pack_operator', scope);
      await lockEvidenceOnly(client, manifest);
      await client.query(`SELECT attestation_event_id FROM bb_production_review_attestation_events
        WHERE attestation_event_id=ANY($1::text[]) ORDER BY attestation_event_id FOR SHARE`,
      [[latest.industry_attestation_event_id, latest.technical_attestation_event_id].sort()]);
      const lockedLatest = await latestEvent(client, packId);
      if (!lockedLatest || lockedLatest.id !== latest.id) fail('CURRENT_EVENT_CHANGED');
      const occurredAt = new Date().toISOString();
      const withdrawn = withdrawRulePack(latest.pack_snapshot as RulePack, { withdrawn_by: actor, withdrawn_at: occurredAt, reason: input.reason });
      const inserted = await client.query(`INSERT INTO bb_rule_pack_production_release_events
        (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,coverage_version,coverage_hash,
         target_event_id,market,offering,instruments,document_stages,effective_from,effective_to,pack_snapshot,template_snapshot,coverage_snapshot,
         source_check_ids,sample_evidence_ids,operator_user_id,operator_grant_id,industry_reviewer_user_id,industry_reviewer_grant_id,
         technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at,manifest_id,manifest_version,manifest_content_sha256,
         industry_attestation_event_id,technical_attestation_event_id)
        VALUES($1,$2,$3,$4,$5,'production_withdrawal',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::text[],$17,$18,
         $19::jsonb,$20::jsonb,$21::jsonb,$22::text[],$23::text[],$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
        RETURNING *`, [uid(), packId, input.request_id, requestHash, Number(latest.sequence) + 1, latest.pack_version, latest.content_hash,
        latest.template_version, latest.template_hash, latest.coverage_version, latest.coverage_hash, latest.id, latest.market, latest.offering,
        latest.instruments, latest.document_stages, latest.effective_from, latest.effective_to, json(withdrawn), json(latest.template_snapshot),
        json(latest.coverage_snapshot), latest.source_check_ids, latest.sample_evidence_ids, actor, operator.id,
        latest.industry_reviewer_user_id, latest.industry_reviewer_grant_id, latest.technical_reviewer_user_id,
        latest.technical_reviewer_grant_id, input.reason, occurredAt, latest.manifest_id, latest.manifest_version,
        latest.manifest_content_sha256, latest.industry_attestation_event_id, latest.technical_attestation_event_id]);
      await appendActorAudit(client, actor, inserted.rows[0], 'production_withdrawal', operator);
      return eventDto(inserted.rows[0]);
    });
  });

  app.post('/api/v1/rule-pack-releases/:pack_id/rollbacks', { schema: {
    body: productionRulePackReleaseSchemas.ProductionRulePackReleaseActionRequest,
    response: { 200: productionRulePackReleaseSchemas.ProductionRulePackReleaseEvent },
  } }, async request => {
    const actor = await deps.actor(request), packId = (request.params as any).pack_id as string;
    const input = request.body as ProductionRulePackReleaseActionRequest;
    const requestHash = sha({ action: 'production_rollback', actor, pack_id: packId, ...input });
    return tx(deps.db(), async client => {
      await lockPack(client, packId);
      const priorReplay = await replay(client, packId, input.request_id, requestHash, actor);
      if (priorReplay) return priorReplay;
      await activeActor(client, actor);
      const latest = await latestEventPeek(client, packId);
      if (!latest || !['production_release','production_rollback','production_withdrawal'].includes(latest.action)) fail('CURRENT_EVENT_REQUIRED');
      const targetResult = await client.query(`SELECT * FROM bb_rule_pack_production_release_events
        WHERE pack_id=$1 AND id=$2`, [packId, input.target_event_id]);
      const target = targetResult.rows[0] as ReleaseRow | undefined;
      if (!target || Number(target.sequence) >= Number(latest.sequence) || !['production_release','production_rollback'].includes(target.action)) fail('INVALID_ROLLBACK_TARGET');
      const manifest = await manifestForEvent(client, target);
      const scope = manifest.content.applicability_scope;
      const operatorCandidate = await scopedGrant(client, actor, 'rule_pack_operator', scope, 'NONE');
      const approvals = await approvedAttestations(client, actor, manifest, operatorCandidate, packId);
      const evidence = await lockAndValidateEvidence(client, manifest);
      await lockApprovalEvents(client, approvals);
      if (approvals.industry.event.attestation_event_id !== target.industry_attestation_event_id ||
          approvals.technical.event.attestation_event_id !== target.technical_attestation_event_id) fail('ROLLBACK_APPROVAL_DRIFT');
      const lockedTarget = await client.query(`SELECT id FROM bb_rule_pack_production_release_events
        WHERE pack_id=$1 AND id=$2 FOR SHARE`, [packId, target.id]);
      if (!lockedTarget.rowCount) fail('INVALID_ROLLBACK_TARGET');
      const lockedLatest = await latestEvent(client, packId);
      if (!lockedLatest || lockedLatest.id !== latest.id) fail('CURRENT_EVENT_CHANGED');
      const occurredAt = new Date().toISOString();
      const inserted = await client.query(`INSERT INTO bb_rule_pack_production_release_events
        (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,coverage_version,coverage_hash,
         target_event_id,market,offering,instruments,document_stages,effective_from,effective_to,pack_snapshot,template_snapshot,coverage_snapshot,
         source_check_ids,sample_evidence_ids,operator_user_id,operator_grant_id,industry_reviewer_user_id,industry_reviewer_grant_id,
         technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at,manifest_id,manifest_version,manifest_content_sha256,
         industry_attestation_event_id,technical_attestation_event_id)
        VALUES($1,$2,$3,$4,$5,'production_rollback',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::text[],$17,$18,
         $19::jsonb,$20::jsonb,$21::jsonb,$22::text[],$23::text[],$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
        RETURNING *`, [uid(), packId, input.request_id, requestHash, Number(latest.sequence) + 1, target.pack_version, target.content_hash,
        target.template_version, target.template_hash, target.coverage_version, target.coverage_hash, target.id, target.market, target.offering,
        target.instruments, target.document_stages, target.effective_from, target.effective_to, json(target.pack_snapshot), json(target.template_snapshot),
        json(target.coverage_snapshot), evidence.sourceIds, evidence.sampleIds, actor, operatorCandidate.id,
        target.industry_reviewer_user_id, target.industry_reviewer_grant_id, target.technical_reviewer_user_id,
        target.technical_reviewer_grant_id, input.reason, occurredAt, target.manifest_id, target.manifest_version,
        target.manifest_content_sha256, target.industry_attestation_event_id, target.technical_attestation_event_id]);
      await appendActorAudit(client, actor, inserted.rows[0], 'production_rollback', operatorCandidate, approvals.industry, approvals.technical);
      return eventDto(inserted.rows[0]);
    });
  });
}
