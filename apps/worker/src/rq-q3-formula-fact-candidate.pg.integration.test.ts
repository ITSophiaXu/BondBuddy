import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { appendIssuerIdentitySourceRecord, authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';
import { verifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import { listFactCandidates } from './fact-repository.js';
import { persistParseSnapshot } from './parse-evidence-repository.js';
import type { DocumentParseRecord } from './document-parser.js';
import { createControlledNativeFactCandidateProducer } from './controlled-native-fact-candidate-producer.js';
import { RQ_Q3_FORMULA_SOURCE_SHA256 } from './rq-q3-formula-candidate-constants.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('RQ_Q3_FORMULA_FACT_CANDIDATE_TEST_DATABASE_URL');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
const ACCEPTED_PARSER = 'bondbuddy-document-parser-1.0.7';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stableRef = (sheet: string, cell: string) => `xlsx:${encodeURIComponent(sheet)}:cell:${cell}`;

type Statement = {
  readonly sheet: string; readonly title: string; readonly period: string; readonly periodFormula: boolean;
  readonly headerCell: string; readonly header: string; readonly unitCell: string;
  readonly cells: readonly { readonly labelCell: string; readonly valueCell: string; readonly label: string;
    readonly formula: string }[];
};

// Mirrors the eight allowlisted current-period cells from the authorized rq-202509-02 map.
const statements: readonly Statement[] = [
  { sheet: '01合并资产负债表', title: '合并资产负债表', period: '2025年9月30日', periodFormula: false,
    headerCell: 'D4', header: '期末余额', unitCell: 'E3', cells: [
      { labelCell: 'A78', valueCell: 'D78', label: '资产总计', formula: '=D29+D56' }] },
  { sheet: '01母公司资产负债', title: '母公司资产负债表', period: '2025年9月30日', periodFormula: true,
    headerCell: 'D4', header: '期末余额', unitCell: 'F3', cells: [
      { labelCell: 'A78', valueCell: 'D78', label: '资产总计', formula: '=D29+D56' }] },
  { sheet: '02合并利润表', title: '合并利润表', period: '2025年1-9月', periodFormula: false,
    headerCell: 'D4', header: '2025年1-9月', unitCell: 'E3', cells: [
      { labelCell: 'A6', valueCell: 'D6', label: '其中：营业收入', formula: '=[1]利润试算!$AI$7' },
      { labelCell: 'A44', valueCell: 'D44', label: '净利润', formula: '=D42-D43' }] },
  { sheet: '02母公司利润表', title: '母公司利润表', period: '2025年1-9月', periodFormula: true,
    headerCell: 'D4', header: '本期金额', unitCell: 'E3', cells: [
      { labelCell: 'A6', valueCell: 'D6', label: '其中：营业收入', formula: '=[1]利润试算!$C$7' },
      { labelCell: 'A44', valueCell: 'D44', label: '净利润', formula: '=D42-D43' }] },
  { sheet: '03合并现金流量表', title: '合并现金流量表', period: '2025年1-9月', periodFormula: false,
    headerCell: 'C4', header: '2025年1-9月', unitCell: 'D3', cells: [
      { labelCell: 'A32', valueCell: 'C32', label: '经营活动产生的现金流量净额', formula: '=C20-C31' }] },
  { sheet: '03母公司现金流量表', title: '母公司现金流量表', period: '2025年1-9月', periodFormula: true,
    headerCell: 'C4', header: '本期金额', unitCell: 'D3', cells: [
      { labelCell: 'A32', valueCell: 'C32', label: '经营活动产生的现金流量净额', formula: '=C20-C31' }] },
];

type BuildOptions = { readonly parserVersion: string; readonly materialId: string; readonly requestId: string;
  /** One exact formula cell whose cached result is genuinely absent (never a literal value). */
  readonly missingCacheCell?: { readonly sheet: string; readonly cell: string } };

function buildResponse(options: BuildOptions) {
  const records: DocumentParseRecord[] = [];
  let ordinal = 0;
  let cachedFormulas = 0, missingFormulas = 0;
  const add = (sheet: string, cell: string, literal: string, formatting: Record<string, unknown>, uncertainty: string[]) => {
    records.push({
      record_id: `synthetic-q3-evidence-${ordinal++}`, material_id: options.materialId, material_version: 1,
      content_hash: RQ_Q3_FORMULA_SOURCE_SHA256, locator_type: 'xlsx_cell',
      locator: { sheet, cell, merged_range: null, stable_ref: stableRef(sheet, cell) },
      literal_quote: literal, context: '', extraction_method: 'native_text', extractor_version: options.parserVersion,
      confidence: 1, uncertainty, formatting: { sheet_state: 'visible', ...formatting },
    });
  };
  const isMissing = (sheet: string, cell: string) => options.missingCacheCell?.sheet === sheet && options.missingCacheCell.cell === cell;
  for (const statement of statements) {
    add(statement.sheet, 'A1', statement.title, {}, []);
    add(statement.sheet, 'B3', statement.periodFormula ? `=period!A1` : statement.period,
      statement.periodFormula ? { cached_formula_result: statement.period } : {},
      statement.periodFormula ? ['formula_cached_result_unverified'] : []);
    if (statement.periodFormula) cachedFormulas++;
    add(statement.sheet, statement.headerCell, statement.header, {}, []);
    add(statement.sheet, statement.unitCell, '金额单位：人民币元', {}, []);
    for (const cell of statement.cells) {
      add(statement.sheet, cell.labelCell, cell.label, {}, []);
      if (isMissing(statement.sheet, cell.valueCell)) {
        add(statement.sheet, cell.valueCell, cell.formula, {}, ['formula_result_not_cached']);
        missingFormulas++;
      } else {
        add(statement.sheet, cell.valueCell, cell.formula, { cached_formula_result: '123.4500' },
          ['formula_cached_result_unverified']);
        cachedFormulas++;
      }
    }
  }
  // A hidden auxiliary formula stays outside the exact visible current-period allowlist.
  add('Sheet1', 'A1', '=SUM(A2:A3)', { sheet_state: 'hidden', cached_formula_result: '999' },
    ['formula_cached_result_unverified']);
  cachedFormulas++;
  return {
    schema_version: 'document-parse-response-v1', request_id: options.requestId, parser_version: options.parserVersion,
    status: 'needs_confirmation', material: { material_id: options.materialId, material_version: 1,
      media_type: XLSX, sha256: RQ_Q3_FORMULA_SOURCE_SHA256 },
    records, warnings: [
      { code: 'XLSX_HIDDEN_SHEET', message: 'synthetic hidden sheet' },
      { code: 'XLSX_FORMULA_CACHE_UNVERIFIED', message: 'synthetic unverified formula caches' },
    ],
    document: { page_count: null, worksheet_count: statements.length + 1, missing_formula_results: missingFormulas,
      cached_formula_results: cachedFormulas },
    error: null,
  };
}

test('rq Q3 formula candidates persist as external needs_confirmation, replay idempotently, isolate owners, and fail closed without a cache or on an unsupported parser version',
  { skip: !testDatabaseUrl && 'set RQ_Q3_FORMULA_FACT_CANDIDATE_TEST_DATABASE_URL or BB_TEST_DATABASE_URL for migrated PostgreSQL 16' },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 8 });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `q3-fact-owner-${suffix}`, foreignOwner = `q3-fact-foreign-${suffix}`;
    const reviewerId = `q3-fact-reviewer-${suffix}`, grantorId = `q3-fact-grantor-${suffix}`;
    const projectId = `q3-fact-project-${suffix}`;
    const materialId = `q3-fact-material-${suffix}`, uploadId = `q3-fact-upload-${suffix}`;
    const identityRecordId = 'synthetic-q3-evidence-0';
    const reviewerGrantId = randomUUID();
    const ownerScope = { ownerUserId: owner, projectId };
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4),($5,$6),($7,$8)',
        [owner, `q3factowner${suffix}`, foreignOwner, `q3factforeign${suffix}`, reviewerId, `q3factreviewer${suffix}`,
          grantorId, `q3factgrantor${suffix}`]);
      await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic Q3 formula candidates','update')`,
        [projectId, owner]);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'synthetic-q3.xlsx',$4,424900,$5,'interimFinancial',$6,now()+interval '1 hour','completed',$5,424900)`,
      [uploadId, owner, projectId, XLSX, RQ_Q3_FORMULA_SOURCE_SHA256, `synthetic/q3/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'interimFinancial','synthetic-q3.xlsx',$5,424900,$6,$7,'parsed')`,
      [materialId, owner, projectId, uploadId, XLSX, RQ_Q3_FORMULA_SOURCE_SHA256, `synthetic/q3/material/${materialId}`]);

      const positive = await persistParseSnapshot({ pool }, { ownerUserId: owner, projectId, materialId, materialVersion: 1,
        requestId: `q3-parse-positive-${suffix}` }, { mediaType: XLSX, sha256: RQ_Q3_FORMULA_SOURCE_SHA256 },
      buildResponse({ parserVersion: ACCEPTED_PARSER, materialId, requestId: `q3-parse-positive-${suffix}` }));
      assert.equal(positive.response.status, 'needs_confirmation');

      const observation = await appendIssuerIdentitySourceRecord({ pool }, { ownerUserId: owner, projectId,
        materialId, materialVersion: 1, requestId: `q3-identity-${suffix}`, sourceRecordId: identityRecordId,
        issuerDisplayName: '合成任丘发行人', entityId: `q3-observed-${suffix}` });
      await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test',$4,$5)`, [reviewerGrantId, reviewerId, grantorId, owner, projectId]);
      const reviewer = await authorizeIssuerIdentityReviewer(pool, reviewerId);
      assert.ok(reviewer);
      await reviewIssuerIdentitySourceRecord({ pool }, { ownerUserId: owner, projectId, materialId, materialVersion: 1,
        sourceRecordRowId: observation.id, reviewer, decision: 'verified',
        verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111', entityBasisKind: 'manual_attestation',
        entityBasisRef: 'synthetic Q3 identity fixture', reasonCode: 'synthetic_verified' });
      const identityRecord = await import('@bondbuddy/api/issuer-identity-source').then(({ loadVerifiedIssuerIdentitySourceRecord }) =>
        loadVerifiedIssuerIdentitySourceRecord(pool, { ownerUserId: owner, projectId, materialId, materialVersion: 1 }));
      assert.ok(identityRecord);
      const inputHash = sha(`synthetic Q3 input ${suffix}`);
      await pool.query(`INSERT INTO bb_input_revisions
        (project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`, [projectId, owner, inputHash,
        JSON.stringify({ issuer_identity: verifiedIssuerIdentityBinding(identityRecord), issuer_entity_id: identityRecord.entityId,
          materials: [{ material_id: materialId, material_version: 1, role: 'interimFinancial', sha256: RQ_Q3_FORMULA_SOURCE_SHA256 }] }),
        JSON.stringify([{ material_id: materialId, material_version: 1 }])]);

      const producer = createControlledNativeFactCandidateProducer({ pool });
      const context = { ownerUserId: owner, projectId, inputRevision: 1, inputHash, materialId, materialVersion: 1,
        snapshotId: positive.snapshotId };
      const produced = await producer(context);
      assert.equal(produced.inserted.length, 8, 'the eight allowlisted formula-cache cells persist as candidates');
      assert.equal(produced.needsReview.length, 0);
      const candidates = await listFactCandidates({ pool }, ownerScope);
      assert.equal(candidates.length, 8);
      assert.ok(candidates.every(item => item.candidate.source.kind === 'external' &&
        item.provenance.status === 'needs_confirmation' && item.candidate.auditCheck === null &&
        item.provenance.uncertainty.some(reason => reason.includes('FORMULA_CACHE_VALUE_UNVERIFIED')) &&
        item.provenance.uncertainty.some(reason => reason.includes('FORMULA_SOURCE_CHAIN_UNVERIFIED'))));
      assert.ok(candidates.filter(item => item.candidate.identity.metric === 'operating_revenue')
        .every(item => item.provenance.uncertainty.some(reason => reason.includes('REVENUE_EXTERNAL_WORKBOOK_NOT_AUTHORIZED'))),
      'the two revenue cells retain the unauthorized external-workbook marker');
      assert.ok(candidates.filter(item => item.candidate.identity.scope === 'parent_only')
        .every(item => item.provenance.uncertainty.some(reason => reason.includes('PERIOD_HEADER_FORMULA_CACHE_UNVERIFIED'))));
      const durable = await pool.query<{ source_kind: string; status: string; uncertainty: string[] }>(
        `SELECT source_kind,status,uncertainty FROM bb_fact_candidates
          WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3`, [owner, projectId, materialId]);
      assert.equal(durable.rowCount, 8);
      assert.ok(durable.rows.every(row => row.status === 'needs_confirmation' && row.source_kind === 'external'));

      const replay = await producer(context);
      assert.equal(replay.inserted.length, 0, 'exact replay inserts nothing new');
      assert.equal(replay.replayed.length, 8, 'exact replay returns the eight prior candidates');
      const ledger = await pool.query<{ extractor_id: string; candidate_ids: string[] }>(
        `SELECT extractor_id,candidate_ids FROM bb_fact_extraction_runs
          WHERE owner_user_id=$1 AND project_id=$2 AND input_revision=1 AND material_id=$3`, [owner, projectId, materialId]);
      assert.equal(ledger.rowCount, 1);
      assert.equal(ledger.rows[0]!.extractor_id, 'rq-202509-q3-formula-cache-candidates');
      assert.equal(ledger.rows[0]!.candidate_ids.length, 8);
      const outbox = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM bb_outbox
        WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='fact.extraction.completed'`, [owner, projectId]);
      assert.equal(Number(outbox.rows[0]!.count), 1, 'candidate persistence and its outbox event commit once');

      assert.equal((await listFactCandidates({ pool }, { ownerUserId: foreignOwner, projectId })).length, 0,
        'another owner cannot read these persisted candidates');
      await assert.rejects(producer({ ...context, ownerUserId: foreignOwner }), /FACT_EXTRACTION_INPUT_REVISION_MISMATCH/,
        'another owner cannot run extraction from this immutable input pin');

      // Negative: one allowlisted formula is genuinely uncached. It fails closed as needs_review and
      // is never promoted to a candidate, while the remaining seven still persist.
      const missingRequestId = `q3-parse-missing-${suffix}`;
      const missing = await persistParseSnapshot({ pool }, { ownerUserId: owner, projectId, materialId, materialVersion: 1,
        requestId: missingRequestId }, { mediaType: XLSX, sha256: RQ_Q3_FORMULA_SOURCE_SHA256 },
      buildResponse({ parserVersion: 'bondbuddy-document-parser-1.0.6', materialId, requestId: missingRequestId,
        missingCacheCell: { sheet: '01合并资产负债表', cell: 'D78' } }));
      const missingResult = await producer({ ...context, snapshotId: missing.snapshotId });
      assert.equal(missingResult.inserted.length, 7);
      assert.equal(missingResult.needsReview.length, 1);
      assert.equal(missingResult.needsReview[0]!.reason_code, 'RQ_Q3_FORMULA_CACHE_MISSING');
      const missingCandidates = await listFactCandidates({ pool }, ownerScope);
      assert.equal(missingCandidates.length, 15, 'the uncached cell adds no candidate to the seven cached ones');
      assert.ok(!missingResult.inserted.some(item => item.candidate.identity.metric === 'total_assets' &&
        item.candidate.identity.scope === 'consolidated'),
      'the uncached formula never becomes a candidate even for the exact target cell');
      assert.deepEqual(missingResult.inserted.map(item => `${item.candidate.identity.scope}:${item.candidate.identity.metric}`).sort(), [
        'consolidated:net_cash_from_operating_activities', 'consolidated:net_profit', 'consolidated:operating_revenue',
        'parent_only:net_cash_from_operating_activities', 'parent_only:net_profit', 'parent_only:operating_revenue',
        'parent_only:total_assets',
      ]);

      // Negative: an unsupported parser version fails the whole source closed to needs_review.
      const changedRequestId = `q3-parse-changed-${suffix}`;
      const changed = await persistParseSnapshot({ pool }, { ownerUserId: owner, projectId, materialId, materialVersion: 1,
        requestId: changedRequestId }, { mediaType: XLSX, sha256: RQ_Q3_FORMULA_SOURCE_SHA256 },
      buildResponse({ parserVersion: 'bondbuddy-document-parser-1.0.9', materialId, requestId: changedRequestId }));
      const changedResult = await producer({ ...context, snapshotId: changed.snapshotId });
      assert.equal(changedResult.inserted.length, 0, 'an unsupported parser version yields no candidates');
      assert.equal(changedResult.needsReview.length, 1);
      assert.equal(changedResult.needsReview[0]!.reason_code, 'RQ_Q3_FORMULA_SOURCE_OR_PARSER_UNSUPPORTED');
      assert.equal((await listFactCandidates({ pool }, ownerScope)).length, 15);
    } finally {
      await pool.end();
    }
  });
