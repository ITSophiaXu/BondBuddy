import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { schemas, type FactEvidenceReviewerReadResponse } from '@bondbuddy/contracts';
import { normalizeDecimal } from '@bondbuddy/domain/facts';
import { Problem, missing } from './data.js';

type Row = Record<string, any>;
type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };
type Client = Queryable & { release(): void | Promise<void> };
type Db = Queryable & { connect(): Promise<Client> };
type Principal = { userId: string };
type Cursor = { v: 1; project_id: string; candidate_id: string; context_id: string; evidence_set_sha256: string; after: number };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const PAGE_SIZE = 50;

function fail(code: string): Error { const error = new Error(code); error.name = 'FactEvidenceReadError'; return error; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('FACT_EVIDENCE_READ_DATA_INVALID'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw fail('FACT_EVIDENCE_READ_DATA_INVALID');
  return encoded;
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function stale(): Error { return fail('FACT_EVIDENCE_READ_STALE'); }
function parseCursor(value: string | undefined, projectId: string, candidateId: string): Cursor | null {
  if (value === undefined) return null;
  if (value.length > 2048) throw fail('FACT_EVIDENCE_READ_INVALID');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (parsed.v !== 1 || typeof parsed.project_id !== 'string' || typeof parsed.candidate_id !== 'string' ||
      typeof parsed.context_id !== 'string' || typeof parsed.evidence_set_sha256 !== 'string' || !SHA.test(parsed.evidence_set_sha256) ||
      !Number.isSafeInteger(parsed.after) || Number(parsed.after) < 0) throw new Error('shape');
    if (parsed.project_id !== projectId || parsed.candidate_id !== candidateId) throw stale();
    return parsed as Cursor;
  } catch (error) {
    if (error instanceof Error && error.message === 'FACT_EVIDENCE_READ_STALE') throw error;
    throw fail('FACT_EVIDENCE_READ_INVALID');
  }
}

async function readFactEvidence(db: Db, principal: Principal, projectId: string, candidateId: string, cursorValue?: string): Promise<FactEvidenceReviewerReadResponse> {
  if (!principal || !ID.test(principal.userId) || !ID.test(projectId) || !ID.test(candidateId)) throw fail('FACT_EVIDENCE_READ_INVALID');
  const cursor = parseCursor(cursorValue, projectId, candidateId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const grant = await client.query(`SELECT p.owner_user_id,g.id AS grant_id
      FROM bb_projects p JOIN bb_fact_evidence_reviewer_grants g ON g.scope_owner_user_id=p.owner_user_id AND g.scope_project_id=p.id
      JOIN bb_users u ON u.id=g.user_id AND u.status='active'
      WHERE p.id=$1 AND p.deleted_at IS NULL AND g.user_id=$2 AND g.role='fact_evidence_reviewer' AND g.revoked_at IS NULL
      FOR SHARE OF p,g,u`, [projectId, principal.userId]);
    if (grant.rows.length !== 1) throw missing();
    const ownerId = String(grant.rows[0]!.owner_user_id), grantId = String(grant.rows[0]!.grant_id);

    // Select exactly the newest server-derived context. If it has become stale, never fall back.
    const latest = await client.query(`SELECT x.id FROM bb_fact_evidence_context_sets x
      WHERE x.owner_user_id=$1 AND x.project_id=$2 AND x.candidate_id=$3
      ORDER BY x.created_at DESC,x.id DESC LIMIT 1 FOR SHARE`, [ownerId, projectId, candidateId]);
    if (!latest.rows[0]) throw missing();
    const contextId = String(latest.rows[0].id);
    const current = await client.query(`SELECT x.*,c.fact_key_hash,c.fact_key,c.value_kind,c.value_decimal,c.value_text,c.source_kind,c.source_ref,
        c.status AS candidate_status,c.uncertainty AS candidate_uncertainty,p.latest_input_revision,p.draft_revision,
        i.draft_revision AS input_draft_revision,m.sha256 AS live_material_sha256,s.response_status,s.response_schema_version,
        s.response_sha256 AS live_response_sha256,s.parser_version AS live_parser_version,s.response_meta,s.record_count
      FROM bb_fact_evidence_context_sets x
      JOIN bb_fact_candidates c ON c.owner_user_id=x.owner_user_id AND c.project_id=x.project_id AND c.id=x.candidate_id
      JOIN bb_projects p ON p.owner_user_id=x.owner_user_id AND p.id=x.project_id AND p.deleted_at IS NULL
      JOIN bb_input_revisions i ON i.owner_user_id=x.owner_user_id AND i.project_id=x.project_id AND i.revision=x.input_revision AND i.input_hash=x.input_hash
      JOIN bb_material_versions m ON m.owner_user_id=x.owner_user_id AND m.project_id=x.project_id AND m.id=x.material_id AND m.version=x.material_version
        AND m.sha256=x.content_sha256 AND m.deleted_at IS NULL
      JOIN bb_parse_snapshots s ON s.owner_user_id=x.owner_user_id AND s.project_id=x.project_id AND s.id=x.snapshot_id
        AND s.material_id=x.material_id AND s.material_version=x.material_version AND s.content_sha256=x.content_sha256
        AND s.parser_version=x.parser_version AND s.response_sha256=x.parse_response_sha256
      WHERE x.owner_user_id=$1 AND x.project_id=$2 AND x.id=$3
        AND p.latest_input_revision=x.input_revision AND p.draft_revision=i.draft_revision
        AND NOT EXISTS(SELECT 1 FROM bb_material_versions newer WHERE newer.owner_user_id=m.owner_user_id AND newer.id=m.id AND newer.version>m.version AND newer.deleted_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM bb_parse_snapshots newer WHERE newer.owner_user_id=s.owner_user_id AND newer.project_id=s.project_id
          AND newer.material_id=s.material_id AND newer.material_version=s.material_version AND (newer.created_at,newer.id)>(s.created_at,s.id))
      FOR SHARE OF x,c,p,i,m,s`, [ownerId, projectId, contextId]);
    if (!current.rows[0]) throw stale();
    const row = current.rows[0]!, manifest = json(row.manifest), responseMeta = json(row.response_meta);
    if (!object(manifest) || !object(responseMeta) || manifest.schema_version !== 'fact-evidence-context-v1' ||
      manifest.candidate_id !== candidateId || manifest.evidence_set_sha256 !== String(row.evidence_set_sha256).trim() ||
      !Array.isArray(manifest.selected_body) || !Array.isArray(manifest.auxiliary_targets) || !Array.isArray(manifest.original_warnings) ||
      manifest.selected_body.length < 1 || manifest.selected_body.length > 500 ||
      !object(responseMeta.material) ||
      responseMeta.schema_version !== row.response_schema_version || responseMeta.status !== row.response_status ||
      responseMeta.parser_version !== row.parser_version || responseMeta.material?.material_id !== row.material_id ||
      Number(responseMeta.material?.material_version) !== Number(row.material_version) || responseMeta.material?.sha256 !== String(row.content_sha256).trim() ||
      !Array.isArray(responseMeta.warnings) || !same(responseMeta.warnings, manifest.original_warnings) ||
      !['parsed', 'needs_confirmation'].includes(String(row.response_status)) || !SHA.test(String(row.live_response_sha256).trim()) ||
      String(row.live_response_sha256).trim() !== String(row.parse_response_sha256).trim() ||
      !SHA.test(String(row.live_material_sha256).trim()) || !SHA.test(String(row.input_hash).trim()) ||
      !SHA.test(String(row.parse_response_sha256).trim()) || !SHA.test(String(row.fact_key_hash).trim())) throw stale();
    if (!object(responseMeta.document) || manifest.auxiliary_targets.length > 1000) throw stale();
    const rawTargets = responseMeta.document.auxiliary_targets;
    if (rawTargets !== undefined && !Array.isArray(rawTargets)) throw stale();
    const parsedTargets = (Array.isArray(rawTargets) ? rawTargets : []) as unknown[];
    if (parsedTargets.length !== manifest.auxiliary_targets.length) throw stale();
    const rawTargetById = new Map<string, Record<string, unknown>>();
    for (const rawTarget of parsedTargets) {
      if (!object(rawTarget) || typeof rawTarget.target_id !== 'string' || rawTargetById.has(rawTarget.target_id)) throw stale();
      rawTargetById.set(rawTarget.target_id, rawTarget);
    }
    for (const target of manifest.auxiliary_targets) {
      if (!object(target) || typeof target.target_id !== 'string' || typeof target.kind !== 'string' || typeof target.part_name !== 'string' ||
        !('part_sha256' in target) || !('target_sha256' in target) || !object(target.scope) || typeof target.parse_status !== 'string') throw stale();
      const parsed = rawTargetById.get(target.target_id);
      if (!parsed || !same({ target_id: target.target_id, kind: target.kind, part_name: target.part_name, part_sha256: target.part_sha256,
        target_sha256: target.target_sha256, scope: target.scope, parse_status: target.parse_status },
      { target_id: parsed.target_id, kind: parsed.kind, part_name: parsed.part_name, part_sha256: parsed.part_sha256,
        target_sha256: parsed.target_sha256, scope: parsed.scope, parse_status: parsed.parse_status })) throw stale();
    }

    const { evidence_set_sha256: manifestHash, ...manifestBase } = manifest;
    let normalizedDecimal: string | null;
    try { normalizedDecimal = row.value_decimal === null ? null : normalizeDecimal(String(row.value_decimal)); }
    catch { throw stale(); }
    const candidateValue = { value_kind: row.value_kind, value_decimal: normalizedDecimal,
      value_text: row.value_text === null ? null : String(row.value_text) };
    if (manifestHash !== hash(manifestBase) || String(row.evidence_set_sha256).trim() !== hash(manifestBase) ||
      manifest.input_revision !== Number(row.input_revision) || manifest.input_hash !== String(row.input_hash).trim() ||
      manifest.material_id !== row.material_id || manifest.material_version !== Number(row.material_version) ||
      manifest.material_sha256 !== String(row.content_sha256).trim() || manifest.snapshot_id !== row.snapshot_id ||
      manifest.parser_version !== row.parser_version || manifest.parse_response_sha256 !== String(row.parse_response_sha256).trim() ||
      manifest.candidate_identity_sha256 !== String(row.fact_key_hash).trim() || manifest.source_kind !== row.source_kind ||
      manifest.candidate_status !== row.candidate_status || !same(manifest.fact_identity, json(row.fact_key)) ||
      !object(manifest.candidate_value) || !same(manifest.candidate_value, candidateValue) ||
      !same(manifest.candidate_uncertainty, json(row.candidate_uncertainty)) ||
      typeof manifest.candidate_confidence !== 'number' || !Number.isFinite(manifest.candidate_confidence) || manifest.candidate_confidence < 0 || manifest.candidate_confidence > 1 ||
      !['decimal','text','unknown','not_applicable'].includes(String(row.value_kind)) ||
      (row.value_kind === 'decimal' && (row.value_decimal === null || row.value_text !== null)) ||
      (row.value_kind === 'text' && (row.value_text === null || row.value_decimal !== null)) ||
      (['unknown','not_applicable'].includes(String(row.value_kind)) && (row.value_text !== null || row.value_decimal !== null))) throw stale();

    const recordInventory = await client.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE content_sha256=$6 AND extractor_version=$7 AND extraction_method='native_text')::int AS eligible
      FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND snapshot_id=$5`,
    [ownerId, projectId, row.material_id, row.material_version, row.snapshot_id, String(row.content_sha256).trim(), row.parser_version]);
    if (Number(recordInventory.rows[0]?.total) !== Number(row.record_count) || Number(recordInventory.rows[0]?.eligible) !== Number(row.record_count)) throw stale();

    const body = manifest.selected_body as Array<Record<string, unknown>>;
    const after = cursor ? cursor.after : 0;
    if (cursor && (cursor.context_id !== contextId || cursor.evidence_set_sha256 !== String(row.evidence_set_sha256).trim())) throw stale();
    if (after > body.length) throw fail('FACT_EVIDENCE_READ_INVALID');
    const selected = body.slice(after, after + PAGE_SIZE);
    if (selected.some(item => !object(item) || typeof item.record_id !== 'string' || !ID.test(item.record_id) || !SHA.test(String(item.content_sha256)) ||
      typeof item.locator_type !== 'string' || !object(item.locator) || !Array.isArray(item.uncertainty))) throw stale();
    const records = selected.length ? await client.query(`SELECT record_id,record_sha256,content_sha256,locator_type,locator,literal_quote,confidence,uncertainty,extractor_version,extraction_method
      FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND snapshot_id=$5 AND record_id=ANY($6::text[])`,
    [ownerId, projectId, row.material_id, row.material_version, row.snapshot_id, selected.map(item => item.record_id)]) : { rows: [] as Row[] };
    if (records.rows.length !== selected.length) throw stale();
    const byId = new Map(records.rows.map(record => [String(record.record_id), record]));
    const items = selected.map(member => {
      const record = byId.get(String(member.record_id));
      if (!record || record.extraction_method !== 'native_text' || record.extractor_version !== row.parser_version ||
        String(record.content_sha256).trim() !== String(row.content_sha256).trim() || String(member.content_sha256) !== String(record.content_sha256).trim() ||
        member.locator_type !== record.locator_type || !same(member.locator, record.locator) ||
        !same(member.confidence, record.confidence === null ? null : Number(record.confidence)) || !same(member.uncertainty, json(record.uncertainty)) ||
        typeof record.literal_quote !== 'string' || !record.literal_quote.length || !SHA.test(String(record.record_sha256).trim())) throw stale();
      return { record_id: String(record.record_id), record_sha256: String(record.record_sha256).trim(), content_sha256: String(record.content_sha256).trim(),
        locator_type: record.locator_type as 'docx_block'|'pdf_bbox'|'xlsx_cell'|'csv_cell'|'text_line', locator: record.locator,
        literal_quote: record.literal_quote, confidence: record.confidence === null ? null : Number(record.confidence), uncertainty: json(record.uncertainty) as unknown[] };
    });
    const warnings = (responseMeta.warnings as unknown[]).map(warning => {
      if (!object(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string') throw stale();
      return { code: warning.code, message: warning.message };
    });
    const nextIndex = after + selected.length;
    const next = nextIndex < body.length ? Buffer.from(JSON.stringify({ v: 1, project_id: projectId, candidate_id: candidateId,
      context_id: contextId, evidence_set_sha256: String(row.evidence_set_sha256).trim(), after: nextIndex } satisfies Cursor)).toString('base64url') : null;
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'project',$3,'fact_evidence.reviewer_read',$4::jsonb)`, [randomUUID(), ownerId, projectId, JSON.stringify({
      reviewer_user_id: principal.userId, reviewer_grant_id: grantId, candidate_id: candidateId, evidence_context_set_id: contextId,
      evidence_set_sha256: String(row.evidence_set_sha256).trim(), snapshot_id: String(row.snapshot_id), parse_response_sha256: String(row.parse_response_sha256).trim(),
      record_refs: items.map(item => ({ record_id: item.record_id, record_sha256: item.record_sha256 })), page_size: items.length })]);
    await client.query('COMMIT');
    return { project_id: projectId, candidate_id: candidateId, evidence_context_set_id: contextId, evidence_set_sha256: String(row.evidence_set_sha256).trim(),
      input_revision: Number(row.input_revision), input_hash: String(row.input_hash).trim(), material_id: String(row.material_id),
      material_version: Number(row.material_version), material_sha256: String(row.content_sha256).trim(), snapshot_id: String(row.snapshot_id),
      parser_version: String(row.parser_version), parse_response_sha256: String(row.parse_response_sha256).trim(),
      candidate: { identity: json(row.fact_key) as Record<string, unknown>, identity_sha256: String(row.fact_key_hash).trim(), value_kind: row.value_kind,
        value_decimal: normalizedDecimal, value_text: row.value_text === null ? null : String(row.value_text),
        source_kind: row.source_kind, source_ref: row.source_ref, status: row.candidate_status,
        uncertainty: json(row.candidate_uncertainty) as unknown[], confidence: Number(manifest.candidate_confidence) },
      parse_warnings: warnings, items, auxiliary_targets: manifest.auxiliary_targets as FactEvidenceReviewerReadResponse['auxiliary_targets'],
      next_cursor: next, verification_effect: 'none' };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { await client.release(); }
}

export function installFactEvidenceReadRoutes(app: FastifyInstance, settings: { db: () => Pool; principal: (request: FastifyRequest) => Promise<Principal> }) {
  app.get('/api/v1/reviewer/projects/:project_id/facts/candidates/:candidate_id/evidence',
    { schema: { querystring: schemas.FactEvidenceReviewerReadQuery, response: { 200: schemas.FactEvidenceReviewerReadResponse } } }, async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const principal = await settings.principal(request), params = request.params as { project_id: string; candidate_id: string };
      const query = request.query as { cursor?: string };
      try { return await readFactEvidence(settings.db(), principal, params.project_id, params.candidate_id, query.cursor); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'FACT_EVIDENCE_READ_STALE') throw new Problem(409, 'INPUT_REVISION_CONFLICT', 'Fact evidence has changed and must be reloaded');
        if (code === 'FACT_EVIDENCE_READ_INVALID') throw new Problem(422, 'VALIDATION_FAILED', 'Fact evidence read request is invalid');
        if (code === 'FACT_EVIDENCE_READ_DATA_INVALID') throw new Problem(503, 'DATA_UNAVAILABLE', 'Fact evidence could not be read consistently');
        if (error instanceof Problem) throw error;
        throw error;
      }
    });
}
