import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  nafmiiMtnDraftRulePack,
  nafmiiMtnChapterTemplate,
  nafmiiMtnCoverageManifest,
  publishRulePack,
  publishRulePackBundle,
  withdrawRulePack,
  rulePackContentHash,
  type ReviewAttestation,
  type RulePack,
} from '@bondbuddy/domain';
import { isolatedTestDatabase } from './test-database.js';
import { inputManifestHash, lockProductionRulePack, type ReviewedContextResult } from '@bondbuddy/api/production-rule-pin';
import { createServer } from '@bondbuddy/api';
import { projectRunExecution, runExecutionOrigin } from '@bondbuddy/api/run-execution';
import { codexModelStage, inputLockStage, type StageContext } from './run-pipeline.js';
import {
  revalidateProductionRulePackPin,
  selectProductionRulePack,
  type ProductionRulePackPin,
  type ProductionRulePackRequest,
} from '@bondbuddy/rule-pack-registry';

const databaseUrl = await isolatedTestDatabase('PRODUCTION_RULE_PACK_SELECTOR_TEST_DATABASE_URL');
const approvedContext = (request: ProductionRulePackRequest, contextPin: Record<string, unknown>): ReviewedContextResult =>
  ({ status: 'approved', reasons: [], request, contextPin } as unknown as ReviewedContextResult);

function transactionalPool(client: PoolClient): Pool {
  let serial = 0;
  return {
    query: (sql: string, values?: unknown[]) => client.query(sql, values),
    connect: async () => {
      const name = `rulepin_preflight_${++serial}`;
      let active = false;
      return { release: () => undefined, query: async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') { await client.query(`SAVEPOINT ${name}`); active = true; return { rows: [] }; }
        if (sql === 'COMMIT') { if (active) await client.query(`RELEASE SAVEPOINT ${name}`); active = false; return { rows: [] }; }
        if (sql === 'ROLLBACK') { if (active) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); } active = false; return { rows: [] }; }
        return client.query(sql, values);
      } };
    },
  } as unknown as Pool;
}
async function preflightRuleReasons(client: PoolClient, ownerUserId: string, projectId: string,
  inputHash: string, selectionRequest: ProductionRulePackRequest, contextPin: Record<string, unknown>,
  revision = 2): Promise<string[]> {
  const app = createServer({ pool: transactionalPool(client), allowedOrigin: 'http://bondbuddy.test',
    principal: async () => ({ userId: ownerUserId, csrfVerified: true }),
    reviewedContextLoader: async (_db, args) => {
      assert.equal(args.currentDraftRevision, 1);
      assert.deepEqual(args.currentMaterialVersions, []);
      return approvedContext(selectionRequest, contextPin);
    } });
  try {
    const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/preflight`,
      headers: { origin: 'http://bondbuddy.test' }, payload: { input_revision: revision, input_hash: inputHash } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'blocked', response.body);
    return response.json().missing_inputs;
  } finally { await app.close(); }
}
const request: ProductionRulePackRequest = {
  market: 'sse', offering: 'public_all', instrument: 'synthetic-corporate-bond',
  documentStage: 'registration', issuerScope: 'synthetic_issuer', investorScope: 'synthetic-investor',
  industry: 'synthetic-industry', specialFeatures: [], asOf: '2026-09-25',
};
const reviews: ReviewAttestation[] = [
  { reviewer_id: 'synthetic-industry-reviewer', reviewer_role: 'industry_reviewer', reviewed_at: '2026-09-24T01:00:00Z', source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic selector fixture only.' },
  { reviewer_id: 'synthetic-technical-reviewer', reviewer_role: 'technical_reviewer', reviewed_at: '2026-09-24T01:01:00Z', source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic selector fixture only.' },
];

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
const hashSnapshot = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

// 0071 requires a production grant and its immutable applicability scope to be
// written at one transaction timestamp. Tests that only need the grant call this
// inside their own transaction (or an already-open one).
const reviewedScope = (evidenceId: string, evidenceSha: string) =>
  ({ mode: 'reviewed_unrestricted', evidence_id: evidenceId, evidence_version: 1, evidence_sha256: evidenceSha });
async function insertScopedGrant(
  db: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  input: { id: string; userId: string; grantorId: string; role: string; market: string; offering: string;
    instruments: string[]; documentStages: string[]; suffix: string },
): Promise<Record<string, unknown>> {
  await db.query(`INSERT INTO bb_rule_pack_production_reviewer_grants(id,user_id,role,market,offering,granted_by,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic_test')`,
  [input.id, input.userId, input.role, input.market, input.offering, input.grantorId]);
  const scope = {
    instruments: input.instruments, document_stages: input.documentStages,
    issuer_scopes: reviewedScope(`synthetic-issuer-scope-${input.suffix}`, 'a'.repeat(64)),
    investor_scopes: reviewedScope(`synthetic-investor-scope-${input.suffix}`, 'b'.repeat(64)),
    industry_codes: reviewedScope(`synthetic-industry-scope-${input.suffix}`, 'c'.repeat(64)),
    special_feature_scope: reviewedScope(`synthetic-feature-scope-${input.suffix}`, 'd'.repeat(64)),
  };
  await db.query(`INSERT INTO bb_rule_pack_production_grant_scopes
      (grant_id,instruments,document_stages,issuer_scopes,investor_scopes,industry_codes,special_feature_scope,scope_hash)
      VALUES($1,$2::text[],$3::text[],$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
  [input.id, scope.instruments, scope.document_stages, JSON.stringify(scope.issuer_scopes),
    JSON.stringify(scope.investor_scopes), JSON.stringify(scope.industry_codes),
    JSON.stringify(scope.special_feature_scope), hashSnapshot(scope)]);
  return scope;
}

function fixture(): { pack: RulePack; template: typeof nafmiiMtnChapterTemplate; coverage: typeof nafmiiMtnCoverageManifest } {
  const draft = structuredClone(nafmiiMtnDraftRulePack) as RulePack;
  draft.pack_id = 'synthetic-selector-pack';
  draft.version = 'synthetic.1';
  draft.scope = { market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], document_stages: ['registration'], issuer_scopes: ['synthetic_issuer'] };
  draft.validity = { published_on: null, effective_from: '2026-01-01', effective_to: null, transition_terms: [] };
  draft.sources = [{ ...draft.sources[0]!, source_id: 'synthetic-source', kind: 'formal_rule', official_url: 'https://example.invalid/source', document_hash: 'a'.repeat(64), published_on: '2025-01-01', effective_from: '2026-01-01', effective_to: null, legal_effective_date_basis: 'explicit_text', effective_date_derivation_evidence: [{ kind: 'synthetic_clause', value: 'clause 1' }], verified_by: 'synthetic-reviewer', verified_at: '2026-09-24T00:00:00Z' }];
  draft.rules = [{ ...draft.rules[0]!, rule_id: 'synthetic-rule', source_ref_ids: ['synthetic-source'],
    applicability: { ...draft.rules[0]!.applicability, issuer_scopes: ['synthetic_issuer'], investor_scopes: ['synthetic-investor'], industries: ['synthetic-industry'], special_features: [] },
    enabled: true, enforcement: 'hard_block', outputs: { when_met: 'pass', when_not_met: 'issue', severity: 'blocking' } }];
  const examplesByPolarity: Record<string, RulePack['rules'][number]['positive_examples']> = {
    positive: draft.rules[0]!.positive_examples,
    negative: draft.rules[0]!.negative_examples,
    boundary: draft.rules[0]!.boundary_examples,
  };
  draft.sample_suite = { suite_id: 'synthetic-samples', version: 'synthetic.1', data_classification: 'authorized_real', cases: draft.sample_suite.cases.map((item, index) => ({ ...item, case_id: `synthetic-case-${index}`, evidence_ref: examplesByPolarity[item.polarity][0]!.evidence_ref, result: 'passed', reviewed_by: 'synthetic-reviewer', reviewed_at: '2026-09-24T00:00:00Z' })) };
  draft.reviews = [];
  draft.release = null;
  draft.withdrawal = null;
  const pack = publishRulePack(draft, { channel: 'production', reviews: structuredClone(reviews), released_by: 'synthetic-operator', released_at: '2026-09-25T02:00:00Z', reason: 'Synthetic selector fixture only; no production evidence.' });
  const template = structuredClone(nafmiiMtnChapterTemplate);
  template.rule_pack_id = pack.pack_id;
  template.template_id = 'synthetic-selector-template';
  template.version = pack.version;
  template.market = pack.scope.market;
  template.offering = pack.scope.offering;
  template.document_stages = pack.scope.document_stages;
  for (const chapter of template.chapters) chapter.source_ref_ids = ['synthetic-source'];
  const coverage = structuredClone(nafmiiMtnCoverageManifest);
  coverage.rule_pack_id = pack.pack_id;
  coverage.manifest_id = 'synthetic-selector-coverage';
  coverage.version = pack.version;
  coverage.items = coverage.items.map((item) => ({ ...item, disposition: 'covered', source_ref_ids: ['synthetic-source'] }));
  coverage.open_blockers = [];
  return { pack, template, coverage };
}

function registryRow(action = 'production_release') {
  const { pack, template, coverage } = fixture();
  return {
    id: 'synthetic-release-event', pack_id: pack.pack_id, action, pack_version: pack.version,
    content_hash: rulePackContentHash(pack), market: pack.scope.market, offering: pack.scope.offering,
    instruments: pack.scope.instruments, document_stages: pack.scope.document_stages,
    effective_from: pack.validity.effective_from, effective_to: pack.validity.effective_to,
    pack_snapshot: pack, source_check_ids: ['synthetic-source-check'], sample_evidence_ids: ['s-positive', 's-negative', 's-boundary'],
    operator_user_id: 'synthetic-operator', operator_grant_id: 'grant-operator',
    industry_reviewer_user_id: 'synthetic-industry-reviewer', industry_reviewer_grant_id: 'grant-industry',
    technical_reviewer_user_id: 'synthetic-technical-reviewer', technical_reviewer_grant_id: 'grant-technical',
    template_snapshot: template, coverage_snapshot: coverage,
    template_version: template.version, template_hash: hashSnapshot(template),
    coverage_version: coverage.version, coverage_hash: hashSnapshot(coverage),
  };
}

function resignMutatedPack(row: ReturnType<typeof registryRow>): void {
  const pack = row.pack_snapshot as RulePack;
  const hash = rulePackContentHash(pack);
  pack.release!.content_hash = hash;
  row.content_hash = hash;
}

test('production selector rejects malformed scope before database access', async () => {
  let calls = 0;
  const result = await selectProductionRulePack({ query: async () => { calls++; return { rows: [] }; } } as never, { ...request, asOf: '2026-02-30' });
  assert.deepEqual(result, { status: 'blocked', reasons: ['invalid_selection_context'] });
  assert.equal(calls, 0);
});

test('selector returns a structured block when the distinct production registry is empty', async () => {
  let statement = '';
  const result = await selectProductionRulePack({ query: async (sql: string) => { statement = sql; return { rows: [] }; } } as never, request);
  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_registry_empty'] });
  assert.match(statement, /bb_rule_pack_production_release_events/);
  assert.doesNotMatch(statement, /bb_rule_pack_release_events/);
});

test('synthetic reviewer or evidence claims cannot produce a production pin', async () => {
  const row = registryRow();
  const calls: string[] = [];
  const pool = { query: async (sql: string) => {
    calls.push(sql);
    return calls.length === 1 ? { rows: [row] } : { rows: [{ reviewers_active: false, sources_current: true, samples_complete: true }] };
  } };
  const result = await selectProductionRulePack(pool as never, { ...request, investorScope: 'synthetic-investor', industry: 'synthetic-industry', specialFeatures: [] });
  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_reviewer_grant_inactive'] });
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /bb_rule_pack_production_source_checks/);
  assert.match(calls[1]!, /s\.verifier_user_id=src->>'verified_by'/);
  assert.match(calls[1]!, /bb_rule_pack_production_sample_evidence/);
});

test('selector never revives a pack after latest withdrawal event', async () => {
  const result = await selectProductionRulePack({ query: async () => ({ rows: [registryRow('production_withdrawal')] }) } as never, request);
  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_withdrawn'] });
});

test('selector rejects self-inconsistent hash snapshots and stale source or sample evidence', async () => {
  const invalid = registryRow();
  invalid.content_hash = 'f'.repeat(64);
  const invalidResult = await selectProductionRulePack({ query: async () => ({ rows: [invalid] }) } as never, request);
  assert.deepEqual(invalidResult, { status: 'blocked', reasons: ['production_rule_pack_snapshot_invalid'] });

  for (const [proof, expected] of [
    [{ reviewers_active: true, sources_current: false, samples_complete: true }, 'production_rule_pack_source_not_current'],
    [{ reviewers_active: true, sources_current: true, samples_complete: false }, 'production_rule_pack_evidence_missing'],
  ] as const) {
    let call = 0;
    const result = await selectProductionRulePack({ query: async () => (++call === 1 ? { rows: [registryRow()] } : { rows: [proof] }) } as never,
      { ...request, investorScope: 'synthetic-investor', industry: 'synthetic-industry', specialFeatures: [] });
    assert.deepEqual(result, { status: 'blocked', reasons: [expected] });
  }
});

test('selector refuses snapshots that bypass publishRulePack business gates', async () => {
  const variants: Array<[string, (pack: RulePack) => void]> = [
    ['unverified lead', (pack) => {
      pack.sources[0]!.kind = 'unverified_lead';
      pack.sources[0]!.verified_by = null;
      pack.sources[0]!.verified_at = null;
      pack.rules[0]!.enabled = false;
      pack.rules[0]!.enforcement = 'research_only';
    }],
    ['disabled rule', (pack) => { pack.rules[0]!.enabled = false; }],
    ['research-only rule', (pack) => { pack.rules[0]!.enforcement = 'research_only'; }],
    ['failed sample', (pack) => { pack.sample_suite.cases[0]!.result = 'failed'; }],
    ['future sample timestamp', (pack) => { pack.sample_suite.cases[0]!.reviewed_at = '2026-09-26T00:00:00Z'; }],
    ['future reviewer timestamp', (pack) => { pack.reviews[0]!.reviewed_at = '2026-09-26T00:00:00Z'; }],
    ['publication date mismatch', (pack) => { pack.validity.published_on = '2026-09-24'; }],
  ];

  for (const [label, mutate] of variants) {
    const row = registryRow();
    mutate(row.pack_snapshot as RulePack);
    resignMutatedPack(row);
    const result = await selectProductionRulePack({
      query: async () => ({ rows: [row] }),
    } as never, request);
    assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_snapshot_invalid'] }, label);
  }
});

test('production selector blocks unknown or conflicting source dates even with a self-consistent content hash', async () => {
  const undated = registryRow();
  const undatedPack = undated.pack_snapshot as RulePack;
  undatedPack.sources[0] = { ...undatedPack.sources[0]!, kind: 'official_interpretation', effective_from: null,
    effective_to: null, legal_effective_date_basis: 'unknown' };
  resignMutatedPack(undated);
  const undatedResult = await selectProductionRulePack({ query: async () => ({ rows: [undated] }) } as never, request);
  assert.deepEqual(undatedResult, { status: 'blocked', reasons: ['production_rule_pack_snapshot_invalid'] },
    'missing signed applicability evidence cannot make a null date current or perpetual');

  const conflict = registryRow();
  const conflictPack = conflict.pack_snapshot as RulePack;
  conflictPack.sources[0]!.legal_effective_date_basis = 'unknown';
  resignMutatedPack(conflict);
  const conflictResult = await selectProductionRulePack({ query: async () => ({ rows: [conflict] }) } as never, request);
  assert.deepEqual(conflictResult, { status: 'blocked', reasons: ['production_rule_pack_snapshot_invalid'] },
    'a populated date cannot be relabeled unknown to evade date review');

  const withdrawn = await selectProductionRulePack({ query: async () => ({ rows: [registryRow('production_withdrawal')] }) } as never, request);
  assert.deepEqual(withdrawn, { status: 'blocked', reasons: ['production_rule_pack_withdrawn'] });
});

test('selector delegates applicability and blocks when investor, industry, or feature evidence is absent', async () => {
  let call = 0;
  const result = await selectProductionRulePack({ query: async () => (++call === 1
    ? { rows: [registryRow()] }
    : { rows: [{ reviewers_active: true, sources_current: true, samples_complete: true }] }) } as never,
  { ...request, investorScope: null, industry: null, specialFeatures: null });
  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_capability_not_ready'] });
});

test('shared selector pins full context and exact-event revalidation never resolves latest', async () => {
  const expectedContext = {
    issuerScope: 'synthetic_issuer', investorScope: 'synthetic-investor',
    industry: 'synthetic-industry', specialFeatures: [],
  };
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = { query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return calls.length % 2 === 1
      ? { rows: [registryRow()] }
      : { rows: [{ reviewers_active: true, sources_current: true, samples_complete: true }] };
  } };
  const selected = await selectProductionRulePack(pool as never, request);
  assert.equal(selected.status, 'selected');
  if (selected.status !== 'selected') return;
  assert.deepEqual(selected.pin.applicabilityContext, expectedContext);

  const verified = await revalidateProductionRulePackPin(pool as never, selected.pin, expectedContext);
  assert.equal(verified.status, 'selected');
  assert.equal(calls[2]!.values?.[0], selected.pin.releaseEventId);
  assert.match(calls[2]!.sql, /FROM bb_rule_pack_production_release_events e WHERE e\.id=\$1/);
  assert.doesNotMatch(calls[2]!.sql, /WITH latest AS/);

  const contextMismatch = await revalidateProductionRulePackPin(pool as never, selected.pin,
    { ...expectedContext, specialFeatures: ['changed-feature'] });
  assert.deepEqual(contextMismatch, { status: 'blocked', reasons: ['production_rule_pack_pin_mismatch'] });

  const tamperedPin = { ...selected.pin, templateHash: 'f'.repeat(64) } satisfies ProductionRulePackPin;
  const tampered = await revalidateProductionRulePackPin(pool as never, tamperedPin, expectedContext);
  assert.deepEqual(tampered, { status: 'blocked', reasons: ['production_rule_pack_pin_mismatch'] });
  assert.equal(calls[4]!.values?.[0], selected.pin.releaseEventId);
});

test('selector requires a covered coverage item for the requested document stage', async () => {
  const row = registryRow();
  const coverage = structuredClone(row.coverage_snapshot);
  coverage.items = coverage.items.map((item) => ({ ...item, document_stages: ['issuance'] }));
  row.coverage_snapshot = coverage;
  row.coverage_hash = hashSnapshot(coverage);
  let call = 0;
  const result = await selectProductionRulePack({ query: async () => (++call === 1
    ? { rows: [row] }
    : { rows: [{ reviewers_active: true, sources_current: true, samples_complete: true }] }) } as never,
  { ...request, investorScope: 'synthetic-investor', industry: 'synthetic-industry', specialFeatures: [] });
  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_scope_mismatch'] });
});

test('live PostgreSQL 16 migration creates empty production registry and rejects missing release proof', {
  skip: !databaseUrl && 'set PRODUCTION_RULE_PACK_SELECTOR_TEST_DATABASE_URL to a migrated PostgreSQL 16 template',
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const count = await pool.query('SELECT count(*)::int AS n FROM bb_rule_pack_production_release_events');
    assert.equal(count.rows[0]!.n, 0, 'migration contains no synthetic production records');
    const tables = await pool.query(`SELECT to_regclass('bb_rule_pack_production_reviewer_grants') AS grants,
      to_regclass('bb_rule_pack_production_source_checks') AS sources,
      to_regclass('bb_rule_pack_production_sample_evidence') AS samples,
      to_regclass('bb_rule_pack_sample_authorizations') AS authorizations,
      to_regclass('bb_rule_pack_release_events') AS test_ledger`);
    assert.ok(tables.rows[0]!.grants);
    assert.ok(tables.rows[0]!.sources);
    assert.ok(tables.rows[0]!.samples);
    assert.ok(tables.rows[0]!.authorizations);
    assert.ok(tables.rows[0]!.test_ledger, 'test ledger remains separate');
    const dateColumns = await pool.query(`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='bb_rule_pack_production_source_checks'
        AND column_name IN ('effective_from','applicability_basis','approved_method_window')`);
    assert.deepEqual(Object.fromEntries(dateColumns.rows.map((row) => [row.column_name, row.is_nullable])), {
      effective_from: 'YES', applicability_basis: 'YES', approved_method_window: 'YES',
    });
    const result = await selectProductionRulePack(pool, request);
    assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_registry_empty'] });
    const suffix = randomUUID().slice(0, 8);
    const admin = `date_admin_${suffix}`;
    const reviewer = `date_reviewer_${suffix}`;
    const grant = `date_grant_${suffix}`;
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$1),($2,$2)', [admin, reviewer]);
    const grantClient = await pool.connect();
    try {
      await grantClient.query('BEGIN');
      await insertScopedGrant(grantClient, { id: grant, userId: reviewer, grantorId: admin, role: 'rule_pack_industry_reviewer',
        market: 'sse', offering: 'public_all', instruments: ['synthetic-instrument'], documentStages: ['registration'], suffix });
      await grantClient.query('COMMIT');
    } catch (error) { await grantClient.query('ROLLBACK'); throw error; } finally { grantClient.release(); }
    const insertSource = `INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,document_hash,
       clause_locator,exact_quote,checked_at,effective_from,effective_to,legal_effective_date_basis,verifier_user_id,verifier_grant_id)
      VALUES($1,'synthetic-date-pack','1',$2,$3,'Synthetic authority','https://example.invalid/source','synthetic-v1',
       'sse','public_all',$4,'synthetic locator','Synthetic only',now(),$5,NULL,$6,$7,$8)`;
    await pool.query(insertSource, [`null-date-${suffix}`, 'a'.repeat(64), `null-source-${suffix}`, 'b'.repeat(64), null, 'unknown', reviewer, grant]);
    const nullDate = await pool.query('SELECT effective_from,legal_effective_date_basis,applicability_basis FROM bb_rule_pack_production_source_checks WHERE id=$1', [`null-date-${suffix}`]);
    assert.equal(nullDate.rows[0]!.effective_from, null);
    assert.equal(nullDate.rows[0]!.legal_effective_date_basis, 'unknown');
    assert.equal(nullDate.rows[0]!.applicability_basis, null, 'pending evidence is retained without implying current applicability');
    await assert.rejects(pool.query(insertSource, [`date-conflict-${suffix}`, 'c'.repeat(64), `conflict-source-${suffix}`, 'd'.repeat(64), null, 'explicit_text', reviewer, grant]), /bb_rule_pack_source_legal_date_basis_guard/);
    await assert.rejects(pool.query(`INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,document_hash,
       clause_locator,exact_quote,checked_at,effective_from,legal_effective_date_basis,effective_date_derivation_evidence,
       official_publication_date,verifier_user_id,verifier_grant_id)
      VALUES($1,'synthetic-date-pack','1',$2,$3,'Synthetic authority','https://example.invalid/source','synthetic-v1',
       'sse','public_all',$4,'synthetic locator','Synthetic only',now(),'2026-01-01','publication_commencement',
       jsonb_build_array(jsonb_build_object('kind','synthetic_clause','value','clause 1')),'2025-12-31',$5,$6)`,
    [`publication-date-conflict-${suffix}`, 'e'.repeat(64), `publication-conflict-source-${suffix}`, 'f'.repeat(64), reviewer, grant]),
    /bb_rule_pack_source_publication_derivation_guard/);
    await assert.rejects(pool.query(`INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,market,offering,instruments,document_stages,
       effective_from,pack_snapshot,operator_user_id,operator_grant_id,reason,occurred_at)
      VALUES ('synthetic-no-proof','synthetic-pack','synthetic-request',$1,1,'production_release','1',$1,
       'sse','public_all',ARRAY['synthetic-instrument'],ARRAY['registration'],'2026-01-01','{}'::jsonb,
       'synthetic-user','synthetic-grant','negative guard test',now())`, ['a'.repeat(64)]), /active scoped production operator grant|required|production/i);
  } finally { await pool.end(); }
});

test('live PostgreSQL 16 accepts an isolated synthetic release and revalidates its exact immutable pin', {
  skip: !databaseUrl && 'set PRODUCTION_RULE_PACK_SELECTOR_TEST_DATABASE_URL to a migrated PostgreSQL 16 template',
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const suffix = Math.random().toString(16).slice(2, 10);
  const operator = `positive_operator_${suffix}`;
  const industry = `positive_industry_${suffix}`;
  const technical = `positive_technical_${suffix}`;
  const admin = `positive_admin_${suffix}`;
  const operatorGrant = `positive_gop_${suffix}`;
  const industryGrant = `positive_gin_${suffix}`;
  const technicalGrant = `positive_gte_${suffix}`;
  const packId = `synthetic-positive-${suffix}`;
  const sourceId = `synthetic-source-${suffix}`;
  const sourceCheckId = `synthetic-source-check-${suffix}`;
  const releaseEventId = `synthetic-release-${suffix}`;
  try {
    await client.query('BEGIN');
    // Fixture publication dates come from UTC ISO strings; keep the SQL event date in the same timezone.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const now = new Date();
    const releaseAt = new Date(now.getTime() + 120_000).toISOString();
    const effectiveTo = new Date(Date.parse(releaseAt) + 86_400_000).toISOString().slice(0, 10);
    for (const [id, username] of [[operator, operator], [industry, industry], [technical, technical], [admin, admin]]) {
      await client.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, username]);
    }
    await insertScopedGrant(client, { id: operatorGrant, userId: operator, grantorId: admin, role: 'rule_pack_operator',
      market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], documentStages: ['registration'], suffix });
    await insertScopedGrant(client, { id: industryGrant, userId: industry, grantorId: admin, role: 'rule_pack_industry_reviewer',
      market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], documentStages: ['registration'], suffix });
    await insertScopedGrant(client, { id: technicalGrant, userId: technical, grantorId: admin, role: 'rule_pack_technical_reviewer',
      market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], documentStages: ['registration'], suffix });

    const draft = structuredClone(nafmiiMtnDraftRulePack) as RulePack;
    draft.pack_id = packId;
    draft.version = 'synthetic.positive.1';
    draft.scope = { market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], document_stages: ['registration'], issuer_scopes: ['synthetic_issuer'] };
    draft.validity = { published_on: null, effective_from: '2026-01-01', effective_to: effectiveTo, transition_terms: [] };
    const source = { ...draft.sources[0]!, source_id: sourceId, kind: 'formal_rule' as const,
      official_url: 'https://example.invalid/synthetic-rule', document_hash: 'a'.repeat(64), source_version: 'synthetic-v1',
      clause_locator: 'synthetic clause 1', exact_quote: 'Synthetic test-only official source evidence.',
      published_on: '2025-01-01', effective_from: '2026-01-01', effective_to: null, legal_effective_date_basis: 'explicit_text', effective_date_derivation_evidence: [{ kind: 'synthetic_clause', value: 'clause 1' }],
      verified_by: industry, verified_at: now.toISOString() };
    draft.sources = [source];
    const firstRule = draft.rules[0]!;
    draft.rules = [{ ...firstRule, rule_id: 'synthetic-rule', source_ref_ids: [sourceId],
      applicability: { ...firstRule.applicability, document_stages: ['registration'], issuer_scopes: ['synthetic_issuer'],
        investor_scopes: ['synthetic-investor'], industries: ['synthetic-industry'], special_features: [] } }];
    const rule = draft.rules[0]!;
    const syntheticSha = (kind: string, index = 0) => hashSnapshot({ synthetic: kind, suffix, index });
    const sourceCheckSha = syntheticSha('source-check');
    const sampleEvidenceShas = [0, 1, 2].map((index) => syntheticSha('sample-evidence', index));
    const sampleExpectedShas = [0, 1, 2].map((index) => syntheticSha('sample-expected', index));
    const sampleReviewedShas = [0, 1, 2].map((index) => syntheticSha('sample-reviewed', index));
    const sampleAuthorizationShas = [0, 1, 2].map((index) => syntheticSha('sample-authorization', index));
    const sampleExamples = [
      ['positive', rule.positive_examples[0]!],
      ['negative', rule.negative_examples[0]!],
      ['boundary', rule.boundary_examples[0]!],
    ] as const;
    draft.sample_suite = { suite_id: 'synthetic-positive-suite', version: 'synthetic.positive.1', data_classification: 'authorized_real',
      cases: sampleExamples.map(([polarity, example], index) => ({ case_id: `synthetic-case-${index}`, polarity,
        evidence_ref: example.evidence_ref, result: 'passed', reviewed_by: industry, reviewed_at: now.toISOString() })) };
    const positiveReviews: ReviewAttestation[] = [
      { reviewer_id: industry, reviewer_role: 'industry_reviewer', reviewed_at: now.toISOString(), source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic PG16 test only.' },
      { reviewer_id: technical, reviewer_role: 'technical_reviewer', reviewed_at: now.toISOString(), source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic PG16 test only.' },
    ];
    const pack = publishRulePack(draft, { channel: 'production', reviews: positiveReviews, released_by: operator,
      released_at: releaseAt, reason: 'Synthetic PG16 test fixture only; not production evidence.' });
    const contentHash = rulePackContentHash(pack);
    await client.query(`INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,document_hash,
       clause_locator,exact_quote,checked_at,effective_from,effective_to,legal_effective_date_basis,effective_date_derivation_evidence,
       official_publication_date,verifier_user_id,verifier_grant_id,source_check_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sse','public_all',$9,$10,$11,$12,'2026-01-01',NULL,'explicit_text',
       jsonb_build_array(jsonb_build_object('kind','synthetic_clause','value','clause 1')),'2024-12-31',$13,$14,$15)`,
    [sourceCheckId, packId, pack.version, contentHash, sourceId, source.authority, source.official_url, source.source_version,
      source.document_hash, source.clause_locator, source.exact_quote, now.toISOString(), industry, industryGrant, sourceCheckSha]);

    const sampleEvidenceIds: string[] = [];
    for (const [index, [polarity, example]] of sampleExamples.entries()) {
      const authorizationId = `synthetic-auth-${suffix}-${index}`;
      const evidenceId = `synthetic-evidence-${suffix}-${index}`;
      const materialHash = (index + 1).toString(16).repeat(64);
      await client.query(`INSERT INTO bb_rule_pack_sample_authorizations
        (id,material_sha256,authorization_document_sha256,authorization_scope,market,offering,authorized_by_user_id,authorizer_grant_id,authorized_at,authorization_evidence_sha256)
        VALUES ($1,$2,$3,'rule_pack_validation','sse','public_all',$4,$5,$6,$7)`,
      [authorizationId, materialHash, (index + 4).toString(16).repeat(64), operator, operatorGrant, now.toISOString(),
        sampleAuthorizationShas[index]]);
      await client.query(`INSERT INTO bb_rule_pack_production_sample_evidence
        (id,sample_case_id,pack_id,pack_version,pack_hash,polarity,material_sha256,authorization_id,market,offering,
         expected_outcome,observed_outcome,source_anchor,reviewer_user_id,reviewer_grant_id,reviewed_at,
         sample_evidence_sha256,expected_outcome_sha256,reviewed_result_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sse','public_all',$9,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [evidenceId, `synthetic-case-${index}`, packId, pack.version, contentHash, polarity, materialHash, authorizationId,
        example.expected_outcome, `synthetic:${polarity}:test-only`, industry, industryGrant, now.toISOString(),
        sampleEvidenceShas[index], sampleExpectedShas[index], sampleReviewedShas[index]]);
      sampleEvidenceIds.push(evidenceId);
    }

    const template = structuredClone(nafmiiMtnChapterTemplate);
    template.rule_pack_id = packId;
    template.template_id = `synthetic-template-${suffix}`;
    template.version = pack.version;
    template.market = 'sse';
    template.offering = 'public_all';
    template.document_stages = ['registration'];
    for (const chapter of template.chapters) chapter.source_ref_ids = [sourceId];
    const coverage = structuredClone(nafmiiMtnCoverageManifest);
    coverage.rule_pack_id = packId;
    coverage.manifest_id = `synthetic-coverage-${suffix}`;
    coverage.version = pack.version;
    coverage.items = coverage.items.map((item) => ({ ...item, disposition: 'covered', document_stages: ['registration'], source_ref_ids: [sourceId] }));
    coverage.open_blockers = [];
    const bundledPack = publishRulePackBundle(draft, template, coverage, { channel: 'production', reviews: positiveReviews,
      released_by: operator, released_at: releaseAt, reason: 'Synthetic PG16 test fixture only; not production evidence.' });
    assert.equal(rulePackContentHash(bundledPack), contentHash);

    // A self-consistent, hash-pinned bundle still cannot use an ambiguous
    // polarity/evidence_ref whose examples disagree on the expected outcome.
    // This exercises the real 0037 trigger with synthetic test rows only.
    const misboundPack = structuredClone(bundledPack);
    const positiveExample = misboundPack.rules[0]!.positive_examples[0]!;
    misboundPack.rules[0]!.positive_examples.push({ ...positiveExample, example_id: 'synthetic-conflicting-example', expected_outcome: 'issue' });
    misboundPack.release!.content_hash = rulePackContentHash(misboundPack);
    const misboundHash = misboundPack.release!.content_hash;
    const misboundSourceId = `misbound-source-check-${suffix}`;
    await client.query(`INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,document_hash,
       clause_locator,exact_quote,checked_at,effective_from,effective_to,legal_effective_date_basis,effective_date_derivation_evidence,
       official_publication_date,verifier_user_id,verifier_grant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sse','public_all',$9,$10,$11,$12,'2026-01-01',NULL,'explicit_text',
       jsonb_build_array(jsonb_build_object('kind','synthetic_clause','value','clause 1')),'2025-01-01',$13,$14)`,
    [misboundSourceId, packId, misboundPack.version, misboundHash, sourceId, source.authority, source.official_url,
      source.source_version, source.document_hash, source.clause_locator, source.exact_quote, now.toISOString(), industry, industryGrant]);
    const misboundEvidenceIds: string[] = [];
    for (const [index, [polarity, example]] of sampleExamples.entries()) {
      const materialHash = (index + 1).toString(16).repeat(64);
      const evidenceId = `misbound-evidence-${suffix}-${index}`;
      await client.query(`INSERT INTO bb_rule_pack_production_sample_evidence
        (id,sample_case_id,pack_id,pack_version,pack_hash,polarity,material_sha256,authorization_id,market,offering,
         expected_outcome,observed_outcome,source_anchor,reviewer_user_id,reviewer_grant_id,reviewed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sse','public_all',$9,$9,$10,$11,$12,$13)`,
      [evidenceId, `synthetic-case-${index}`, packId, misboundPack.version, misboundHash, polarity, materialHash,
        `synthetic-auth-${suffix}-${index}`, example.expected_outcome, `synthetic:${polarity}:wrong-binding-test-only`, industry, industryGrant, now.toISOString()]);
      misboundEvidenceIds.push(evidenceId);
    }
    // 0073 binds every new production release to an immutable frozen manifest and
    // two self-submitted approvals in the same registry. Build that synthetic,
    // test-only binding so the release insert exercises the real 0073 guard.
    const manifestId = packId;
    const manifestVersion = 1;
    const manifestScope = {
      market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], document_stages: ['registration'],
      applicable_from: '2026-01-01', applicable_until: effectiveTo,
      issuer_scopes: reviewedScope(`synthetic-issuer-scope-${suffix}`, 'a'.repeat(64)),
      investor_scopes: reviewedScope(`synthetic-investor-scope-${suffix}`, 'b'.repeat(64)),
      industry_codes: reviewedScope(`synthetic-industry-scope-${suffix}`, 'c'.repeat(64)),
      special_feature_scope: reviewedScope(`synthetic-feature-scope-${suffix}`, 'd'.repeat(64)),
    };
    const manifestContent = {
      contract_version: 'production-review-content-v1', hash_domain: 'bondbuddy:production-review-content:v1',
      rule_pack: { id: packId, version: bundledPack.version, sha256: contentHash },
      chapter_template: { id: template.template_id, version: template.version, sha256: hashSnapshot(template) },
      coverage_manifest: { id: coverage.manifest_id, version: coverage.version, sha256: hashSnapshot(coverage) },
      applicability_scope: manifestScope,
      source_date_evidence: [{ source_evidence_id: sourceCheckId, source_check_sha256: sourceCheckSha }],
      authorized_real_sample_evidence: sampleEvidenceIds.map((id, index) => ({
        sample_evidence_id: id, sample_evidence_sha256: sampleEvidenceShas[index],
        authorization_evidence_id: `synthetic-auth-${suffix}-${index}`, authorization_evidence_sha256: sampleAuthorizationShas[index],
        sample_case_id: `synthetic-case-${index}`, polarity: sampleExamples[index]![0],
        expected_outcome_sha256: sampleExpectedShas[index], reviewed_result_sha256: sampleReviewedShas[index],
      })),
    };
    const manifestContentSha = hashSnapshot(manifestContent);
    await client.query(`INSERT INTO bb_production_review_manifests
      (manifest_id,manifest_version,content_sha256,content,request_id,request_hash,frozen_by_user_id,frozen_by_grant_id)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
    [manifestId, manifestVersion, manifestContentSha, JSON.stringify(manifestContent),
      `synthetic-manifest-${suffix}`, hashSnapshot({ synthetic: 'manifest-request', suffix }), industry, industryGrant]);
    const industryAttestationId = `synthetic-industry-attestation-${suffix}`;
    const technicalAttestationId = `synthetic-technical-attestation-${suffix}`;
    const attestationInsert = `INSERT INTO bb_production_review_attestation_events
      (attestation_event_id,manifest_id,manifest_version,content_sha256,request_id,request_hash,reviewer_role,reviewer_user_id,
       grant_id,decision,reason,evidence,reviewed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'approve',$10,$11::jsonb,$12)`;
    await client.query(attestationInsert, [industryAttestationId, manifestId, manifestVersion, manifestContentSha,
      `synthetic-industry-attest-${suffix}`, hashSnapshot({ synthetic: 'industry-attest', suffix }), 'industry', industry,
      industryGrant, 'Synthetic manifest approval only.', JSON.stringify({ synthetic: true }), now.toISOString()]);
    await client.query(attestationInsert, [technicalAttestationId, manifestId, manifestVersion, manifestContentSha,
      `synthetic-technical-attest-${suffix}`, hashSnapshot({ synthetic: 'technical-attest', suffix }), 'technical', technical,
      technicalGrant, 'Synthetic manifest approval only.', JSON.stringify({ synthetic: true }), now.toISOString()]);
    const releaseInsert = `INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
       coverage_version,coverage_hash,market,offering,instruments,document_stages,effective_from,effective_to,
       pack_snapshot,template_snapshot,coverage_snapshot,source_check_ids,sample_evidence_ids,operator_user_id,operator_grant_id,
       industry_reviewer_user_id,industry_reviewer_grant_id,technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at,
       manifest_id,manifest_version,manifest_content_sha256,industry_attestation_event_id,technical_attestation_event_id)
      VALUES ($1,$2,$3,$4,1,'production_release',$5,$6,$7,$8,$9,$10,'sse','public_all',ARRAY['synthetic-corporate-bond'],
       ARRAY['registration'],'2026-01-01',$24,$11::jsonb,$12::jsonb,$13::jsonb,ARRAY[$14]::text[],$15::text[],$16,$17,$18,$19,$20,$21,$22,$23,$25,$26,$27,$28,$29)`;
    const wrongSourcePack = structuredClone(bundledPack);
    wrongSourcePack.sources[0]!.verified_by = `unbound_source_reviewer_${suffix}`;
    wrongSourcePack.release!.content_hash = rulePackContentHash(wrongSourcePack);
    const wrongSourceHash = wrongSourcePack.release!.content_hash;
    const wrongSourceCheckId = `wrong-source-check-${suffix}`;
    await client.query('SAVEPOINT wrong_source_reviewer');
    await client.query(`INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,document_hash,
       clause_locator,exact_quote,checked_at,effective_from,effective_to,legal_effective_date_basis,effective_date_derivation_evidence,
       official_publication_date,verifier_user_id,verifier_grant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sse','public_all',$9,$10,$11,$12,'2026-01-01',NULL,'explicit_text',
       jsonb_build_array(jsonb_build_object('kind','synthetic_clause','value','clause 1')),'2025-01-01',$13,$14)`,
    [wrongSourceCheckId, packId, wrongSourcePack.version, wrongSourceHash, sourceId, source.authority, source.official_url,
      source.source_version, source.document_hash, source.clause_locator, source.exact_quote, now.toISOString(), industry, industryGrant]);
    await assert.rejects(client.query(releaseInsert, [
      `wrong-source-release-${suffix}`, packId, `wrong-source-request-${suffix}`, 'e'.repeat(64), wrongSourcePack.version, wrongSourceHash,
      template.version, hashSnapshot(template), coverage.version, hashSnapshot(coverage), JSON.stringify(wrongSourcePack),
      JSON.stringify(template), JSON.stringify(coverage), wrongSourceCheckId, sampleEvidenceIds, operator, operatorGrant,
      industry, industryGrant, technical, technicalGrant, bundledPack.release!.reason, releaseAt, effectiveTo,
      null, null, null, null, null,
    ]), /production release requires an exactly pinned manifest and both self-attestations/);
    await client.query('ROLLBACK TO SAVEPOINT wrong_source_reviewer');
    await client.query('RELEASE SAVEPOINT wrong_source_reviewer');

    await client.query('SAVEPOINT conflicting_example');
    await assert.rejects(client.query(releaseInsert, [
      `misbound-release-${suffix}`, packId, `misbound-request-${suffix}`, 'd'.repeat(64), misboundPack.version, misboundHash,
      template.version, hashSnapshot(template), coverage.version, hashSnapshot(coverage), JSON.stringify(misboundPack),
      JSON.stringify(template), JSON.stringify(coverage), misboundSourceId, misboundEvidenceIds, operator, operatorGrant,
      industry, industryGrant, technical, technicalGrant, bundledPack.release!.reason, releaseAt, effectiveTo,
      null, null, null, null, null,
    ]), /production release requires an exactly pinned manifest and both self-attestations/);
    await client.query('ROLLBACK TO SAVEPOINT conflicting_example');
    await client.query('RELEASE SAVEPOINT conflicting_example');

    await client.query(releaseInsert, [releaseEventId, packId, `synthetic-request-${suffix}`, 'b'.repeat(64), bundledPack.version, contentHash,
      template.version, hashSnapshot(template), coverage.version, hashSnapshot(coverage), JSON.stringify(bundledPack),
      JSON.stringify(template), JSON.stringify(coverage), sourceCheckId, sampleEvidenceIds, operator, operatorGrant,
      industry, industryGrant, technical, technicalGrant, 'Synthetic PG16 test fixture only; not production evidence.', releaseAt, effectiveTo,
      manifestId, manifestVersion, manifestContentSha, industryAttestationId, technicalAttestationId]);

    const selectionRequest: ProductionRulePackRequest = {
      market: 'sse', offering: 'public_all', instrument: 'synthetic-corporate-bond', documentStage: 'registration',
      issuerScope: 'synthetic_issuer', investorScope: 'synthetic-investor', industry: 'synthetic-industry',
      specialFeatures: [], asOf: now.toISOString().slice(0, 10),
    };
    const selected = await selectProductionRulePack(client, selectionRequest);
    assert.equal(selected.status, 'selected', JSON.stringify(selected));
    if (selected.status !== 'selected') return;
    assert.equal(selected.pin.releaseEventId, releaseEventId);
    assert.deepEqual(selected.pin.applicabilityContext, {
      issuerScope: selectionRequest.issuerScope, investorScope: selectionRequest.investorScope,
      industry: selectionRequest.industry, specialFeatures: [],
    });
    const replay = await revalidateProductionRulePackPin(client, selected.pin, selected.pin.applicabilityContext);
    assert.equal(replay.status, 'selected', JSON.stringify(replay));

    // Synthetic loader seam only. This transaction is rolled back; no reviewed producer or
    // professional authorization is installed by this fixture.
    const projectId = `synthetic-rule-project-${suffix}`;
    const sourceManifest = { kind: 'synthetic_rule_source', draft_revision: 1, materials: [] };
    const sourceHash = inputManifestHash(sourceManifest);
    await client.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering,update_details)
      VALUES($1,$2,'Synthetic rule pin','review','sse','public_all','{}')`, [projectId, operator]);
    await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,'[]','[]')`, [projectId, operator, sourceHash, sourceManifest]);
    const contextPin = { schema_version: 'synthetic-reviewed-context-v1', source_input_revision: 1, source_input_hash: sourceHash,
      fields: Object.fromEntries(Object.entries(selectionRequest).map(([key, value]) =>
        [key, { value, source: 'synthetic_test_only', status: 'reviewed', reviewer: industry, version: 1,
          hash: hashSnapshot({ key, value }) }])), overall_review: { reviewer: industry, version: 1, status: 'synthetic_test_only' } };
    const ref = { context_id: `synthetic-context-${suffix}`, version: 1, content_hash: inputManifestHash(contextPin),
      source_input_revision: 1, source_input_hash: sourceHash };
    const identity = { status: 'verified' as const, record_id: 'synthetic-identity', version: 1,
      content_hash: 'a'.repeat(64), entity_id: 'synthetic-entity', issuer_display_name: 'Synthetic issuer',
      material_id: 'synthetic-material', material_version: 1, source_snapshot_id: 'synthetic-snapshot',
      source_record_id: 'synthetic-record', source_record_sha256: 'b'.repeat(64),
      source_content_sha256: 'c'.repeat(64), reviewed_by: industry, reviewed_at: now.toISOString() };
    const scope = { owner_user_id: operator, id: projectId, market: 'sse', offering: 'public_all' };
    const currentLock = { draftRevision: 1, materials: [] };
    assert.deepEqual(await lockProductionRulePack(client, scope, currentLock, identity, ref),
      { status: 'blocked', reasons: ['rule_applicability_loader_unavailable'] });
    assert.deepEqual(await lockProductionRulePack(client, scope, currentLock, identity, { ...ref, source_input_hash: '0'.repeat(64) },
      async () => approvedContext(selectionRequest, contextPin)),
    { status: 'blocked', reasons: ['rule_applicability_source_input_mismatch'] });
    assert.deepEqual(await lockProductionRulePack(client, scope, currentLock, identity, ref,
      async () => ({ status: 'needs_review', reasons: ['rule_applicability_review_pending'] })),
    { status: 'blocked', reasons: ['rule_applicability_review_pending'] });
    assert.deepEqual(await lockProductionRulePack(client, scope, currentLock, identity, ref,
      async () => approvedContext(selectionRequest, { ...contextPin, overall_review: null })),
    { status: 'blocked', reasons: ['rule_applicability_context_hash_mismatch'] });
    const locked = await lockProductionRulePack(client, scope, currentLock, identity, ref,
      async (_db, args) => {
        assert.equal(args.contextId, ref.context_id);
        assert.equal(args.expectedSourceInputHash, sourceHash);
        assert.equal(args.expectedIssuerBinding, identity);
        assert.equal(args.currentDraftRevision, 1);
        assert.deepEqual(args.currentMaterialVersions, []);
        return approvedContext(selectionRequest, contextPin);
      });
    assert.equal(locked.status, 'selected', JSON.stringify(locked));
    let gateCtx: StageContext | undefined;
    if (locked.status === 'selected') {
      assert.deepEqual(locked.pin, selected.pin);
      assert.deepEqual(locked.applicability, { ref, contextPin });
      assert.notEqual(inputManifestHash({ pin: locked.pin, contextPin }),
        inputManifestHash({ pin: { ...locked.pin, releaseEventId: 'tampered' }, contextPin }));
      const snapshotRefs = { release_event_id: locked.pin.releaseEventId,
        pack_id: locked.pin.packId, pack_version: locked.pin.version, pack_hash: locked.pin.contentHash,
        template_id: locked.pin.templateId, template_version: locked.pin.templateVersion, template_hash: locked.pin.templateHash,
        coverage_id: locked.pin.coverageId, coverage_version: locked.pin.coverageVersion, coverage_hash: locked.pin.coverageHash };
      const manifest = { manifest_schema: 'production_rule_pin_v1', kind: 'review', draft_revision: 1,
        market: 'sse', offering: 'public_all', materials: [], issuer_identity: identity,
        rule_pack_selection: 'selected', rule_pack_block_reasons: [], rule_pack_pin: locked.pin,
        rule_pack_context: locked.pin.applicabilityContext, rule_applicability_pin: locked.applicability,
        rule_pack_snapshot_refs: snapshotRefs, rule_pack_version: locked.pin.version,
        template_version: locked.pin.templateVersion };
      const inputHash = inputManifestHash(manifest);
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
        VALUES($1,2,$2,1,$3,$4,'[]','[]',$5,$6)`, [projectId, operator, inputHash, manifest, locked.pin.version, locked.pin.templateVersion]);
      const run = { id: `synthetic-rule-run-${suffix}`, owner_user_id: operator, project_id: projectId,
        input_revision: 2, input_hash: inputHash, task_kind: 'review' };
      const ctx = { pool: client as never, blobs: {} as never, lease: {} as never,
        run: projectRunExecution(run, { executionVersion: 1, inputRevision: run.input_revision, inputHash: run.input_hash }),
        signal: new AbortController().signal, checkpoint: {}, values: new Map(),
        reviewedContextLoader: async (_db, args) => {
          assert.equal(args.currentDraftRevision, 1);
          assert.equal(args.mode, 'replay');
          assert.deepEqual(args.currentMaterialVersions, []);
          return approvedContext(selectionRequest, contextPin);
        } } as StageContext;
      gateCtx = ctx;
      assert.deepEqual(await inputLockStage.run(ctx), { kind: 'done' });
      let reviewActive = true;
      const app = createServer({ pool: transactionalPool(client), allowedOrigin: 'http://bondbuddy.test',
        principal: async () => ({ userId: operator, csrfVerified: true }),
        reviewedContextLoader: async (_db, args) => {
          assert.equal(args.currentDraftRevision, 1);
          assert.equal(args.mode, 'selection');
          assert.deepEqual(args.currentMaterialVersions, []);
          const draft = await _db.query('SELECT draft_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2', [operator, projectId]);
          if (Number(draft.rows[0]?.draft_revision) !== args.currentDraftRevision)
            return { status: 'needs_review', reasons: ['rule_applicability_current_draft_stale'] };
          return reviewActive ? approvedContext(selectionRequest, contextPin)
            : { status: 'needs_review', reasons: ['rule_applicability_review_revoked'] };
        } });
      const preflight = async () => app.inject({ method: 'POST',
        url: `/api/v1/projects/${projectId}/preflight`, headers: { origin: 'http://bondbuddy.test' },
        payload: { input_revision: 2, input_hash: inputHash } });
      try {
        const initially = await preflight();
        assert.equal(initially.statusCode, 200, initially.body);
        assert.ok(!initially.json().missing_inputs.some((reason: string) => reason.startsWith('rule_pack:')));
        await client.query('UPDATE bb_projects SET draft_revision=2 WHERE owner_user_id=$1 AND id=$2', [operator, projectId]);
        assert.deepEqual(await inputLockStage.run(ctx), { kind: 'done' },
          'a locked run continues after a later project draft edit');
        const stalePreflight = await preflight();
        assert.ok(stalePreflight.json().missing_inputs.includes('rule_pack:rule_applicability_current_draft_stale'));
        assert.deepEqual(await lockProductionRulePack(client, scope, { draftRevision: 2, materials: [] }, identity, ref,
          async () => approvedContext(selectionRequest, contextPin)),
        { status: 'blocked', reasons: ['rule_applicability_source_draft_mismatch'] },
        'a new selection still rejects the stale source');
        reviewActive = false;
        assert.deepEqual(await inputLockStage.run({ ...ctx,
          reviewedContextLoader: async () => ({ status: 'needs_review', reasons: ['rule_applicability_review_revoked'] }) }),
        { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_applicability_review_revoked' });
        await client.query('UPDATE bb_projects SET draft_revision=1 WHERE owner_user_id=$1 AND id=$2', [operator, projectId]);
        const revokedReview = await preflight();
        assert.equal(revokedReview.statusCode, 200, revokedReview.body);
        assert.ok(revokedReview.json().missing_inputs.includes('rule_pack:rule_applicability_review_revoked'));
        reviewActive = true;
        const foreign = createServer({ pool: transactionalPool(client), allowedOrigin: 'http://bondbuddy.test',
          principal: async () => ({ userId: admin, csrfVerified: true }) });
        try {
          const response = await foreign.inject({ method: 'POST',
            url: `/api/v1/projects/${projectId}/preflight`, headers: { origin: 'http://bondbuddy.test' },
            payload: { input_revision: 2, input_hash: inputHash } });
          assert.equal(response.statusCode, 404, response.body);
        } finally { await foreign.close(); }
      } finally { await app.close(); }
      const tamperedManifest = { ...manifest, rule_pack_snapshot_refs: { ...snapshotRefs, pack_hash: '0'.repeat(64) } };
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
        VALUES($1,3,$2,1,$3,$4,'[]','[]',$5,$6)`, [projectId, operator, inputHash, tamperedManifest, locked.pin.version, locked.pin.templateVersion]);
      assert.deepEqual(await inputLockStage.run({ ...ctx,
        run: projectRunExecution({ ...run, input_revision: 3 }, { executionVersion: 1, inputRevision: 3, inputHash: run.input_hash }) }),
        { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
      assert.deepEqual(await inputLockStage.run({ ...ctx, reviewedContextLoader: undefined }),
        { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_applicability_loader_unavailable' });
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
        VALUES($1,4,$2,2,$3,$4,'[]','[]',$5,$6)`,
      [projectId, operator, inputHash, manifest, locked.pin.version, locked.pin.templateVersion]);
      const driftApp = createServer({ pool: transactionalPool(client), allowedOrigin: 'http://bondbuddy.test',
        principal: async () => ({ userId: operator, csrfVerified: true }) });
      try {
        const driftPreflight = await driftApp.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/preflight`,
          headers: { origin: 'http://bondbuddy.test' }, payload: { input_revision: 4, input_hash: inputHash } });
        assert.equal(driftPreflight.statusCode, 409, driftPreflight.body);
        assert.equal(driftPreflight.json().code, 'INPUT_REVISION_CONFLICT', 'advisory business readiness cannot bypass the immutable draft pin');
      } finally { await driftApp.close(); }
      const driftGate = await inputLockStage.run({ ...ctx,
        run: projectRunExecution({ ...run, input_revision: 4 }, { executionVersion: 1, inputRevision: 4, inputHash: run.input_hash }) });
      assert.deepEqual(driftGate, { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
      let driftPromptBuilt = false;
      const driftModel = codexModelStage({ name: 'model_generation', logicalCallId: 'synthetic-rule-drift',
        config: {} as never, schema: {}, validate: () => true, resultSchemaVersion: 'synthetic-v1',
        buildPrompt: async () => { driftPromptBuilt = true; return 'must not reach provider'; } });
      assert.deepEqual(await driftModel.run({ ...ctx, validateBeforeModelCall: async () => driftGate as never }), driftGate);
      assert.equal(driftPromptBuilt, false, 'mirrored draft drift has zero prompt construction and model calls');
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
        VALUES($1,5,$2,1,$3,$4,'[{"material_id":"synthetic-other","material_version":1}]'::jsonb,'[]',$5,$6)`,
      [projectId, operator, inputHash, manifest, locked.pin.version, locked.pin.templateVersion]);
      assert.deepEqual(await inputLockStage.run({ ...ctx,
        run: projectRunExecution({ ...run, input_revision: 5 }, { executionVersion: 1, inputRevision: 5, inputHash: run.input_hash }) }),
        { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    }
    const expiredPin = { ...selected.pin, asOf: new Date(Date.parse(`${effectiveTo}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) };
    assert.deepEqual(await revalidateProductionRulePackPin(client, expiredPin, expiredPin.applicabilityContext),
      { status: 'blocked', reasons: ['production_rule_pack_not_effective'] });
    if (gateCtx) {
      // Keep the exact release event and all proof hashes, but replay it for an as-of date
      // after its effective window. Both public and worker gates must reject that same pin.
      const expiredRequest = { ...selectionRequest, asOf: expiredPin.asOf };
      const expiredContextPin = structuredClone(contextPin);
      expiredContextPin.fields.asOf = { ...expiredContextPin.fields.asOf!, value: expiredPin.asOf,
        hash: hashSnapshot({ key: 'asOf', value: expiredPin.asOf }) };
      const expiredRef = { ...ref, content_hash: inputManifestHash(expiredContextPin) };
      const originalManifest = (await client.query(
        'SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',
        [operator, projectId])).rows[0]!.manifest;
      const expiredManifest = { ...originalManifest,
        rule_pack_pin: expiredPin,
        rule_applicability_pin: { ref: expiredRef, contextPin: expiredContextPin } };
      const expiredHash = inputManifestHash(expiredManifest);
      await client.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
        VALUES($1,6,$2,1,$3,$4,'[]','[]',$5,$6)`,
      [projectId, operator, expiredHash, expiredManifest, expiredPin.version, expiredPin.templateVersion]);
      for (let retry = 0; retry < 2; retry++)
        assert.ok((await preflightRuleReasons(client, operator, projectId, expiredHash,
          expiredRequest, expiredContextPin, 6)).includes('rule_pack:production_rule_pack_not_effective'));
      const expiredRawRun = { ...runExecutionOrigin(gateCtx.run), task_kind: gateCtx.run.task_kind, input_revision: 6, input_hash: expiredHash };
      const expiredCtx = { ...gateCtx,
        run: projectRunExecution(expiredRawRun, { executionVersion: 1, inputRevision: expiredRawRun.input_revision, inputHash: expiredRawRun.input_hash }),
        reviewedContextLoader: async () => approvedContext(expiredRequest, expiredContextPin) };
      const expiredGate = await inputLockStage.run(expiredCtx);
      assert.deepEqual(expiredGate,
        { kind: 'pause', stage: 'capability_not_ready', reason: 'production_rule_pack_not_effective' });
      assert.deepEqual(await inputLockStage.run(expiredCtx), expiredGate,
        'retry must keep the same exact expired pin and pause reason');
      let promptBuilt = false;
      const model = codexModelStage({ name: 'model_generation', logicalCallId: 'synthetic-expired-pin',
        config: {} as never, schema: {}, validate: () => true, resultSchemaVersion: 'synthetic-v1',
        buildPrompt: async () => { promptBuilt = true; return 'must not reach provider'; } });
      assert.deepEqual(await model.run({ ...gateCtx, validateBeforeModelCall: async () => expiredGate as never }), expiredGate);
      assert.equal(promptBuilt, false, 'expired pin has zero prompt construction and model calls');
    }

    const tampered = { ...selected.pin, contentHash: 'f'.repeat(64) };
    assert.deepEqual(await revalidateProductionRulePackPin(client, tampered, selected.pin.applicabilityContext),
      { status: 'blocked', reasons: ['production_rule_pack_pin_mismatch'] });
    assert.deepEqual(await revalidateProductionRulePackPin(client, selected.pin,
      { ...selected.pin.applicabilityContext, industry: 'other-industry' }),
    { status: 'blocked', reasons: ['production_rule_pack_pin_mismatch'] });

    await client.query(`UPDATE bb_rule_pack_production_reviewer_grants SET revoked_at=now() WHERE id=$1`, [industryGrant]);
    if (gateCtx) {
      assert.ok((await preflightRuleReasons(client, operator, projectId, gateCtx.run.input_hash,
        selectionRequest, contextPin)).includes('rule_pack:production_rule_pack_reviewer_grant_inactive'));
      const blocked = await inputLockStage.run(gateCtx);
      assert.deepEqual(blocked,
        { kind: 'pause', stage: 'capability_not_ready', reason: 'production_rule_pack_reviewer_grant_inactive' });
      let promptBuilt = false;
      const model = codexModelStage({ name: 'model_generation', logicalCallId: 'synthetic-rule-gate',
        config: {} as never, schema: {}, validate: () => true, resultSchemaVersion: 'synthetic-v1',
        buildPrompt: async () => { promptBuilt = true; return 'must not reach provider'; } });
      assert.deepEqual(await model.run({ ...gateCtx, validateBeforeModelCall: async () => blocked as never }), blocked);
      assert.equal(promptBuilt, false, 'revoked pin has zero prompt construction and model calls');
    }
    assert.deepEqual(await revalidateProductionRulePackPin(client, selected.pin, selected.pin.applicabilityContext),
      { status: 'blocked', reasons: ['production_rule_pack_reviewer_grant_inactive'] });

    const withdrawalAt = new Date(Date.parse(releaseAt) + 60_000).toISOString();
    const withdrawn = withdrawRulePack(bundledPack, { withdrawn_by: operator, withdrawn_at: withdrawalAt, reason: 'Synthetic PG16 withdrawal replay test only.' });
    await client.query(`INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
       coverage_version,coverage_hash,target_event_id,market,offering,instruments,document_stages,effective_from,effective_to,
       pack_snapshot,template_snapshot,coverage_snapshot,source_check_ids,sample_evidence_ids,operator_user_id,operator_grant_id,reason,occurred_at,
       manifest_id,manifest_version,manifest_content_sha256,industry_attestation_event_id,technical_attestation_event_id)
      VALUES ($1,$2,$3,$4,2,'production_withdrawal',$5,$6,$7,$8,$9,$10,$11,'sse','public_all',
       ARRAY['synthetic-corporate-bond'],ARRAY['registration'],'2026-01-01',$12,$13::jsonb,$14::jsonb,$15::jsonb,
       ARRAY[$16]::text[],$17::text[],$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [`synthetic-withdrawal-${suffix}`, packId, `synthetic-withdraw-request-${suffix}`, 'c'.repeat(64), pack.version,
      contentHash, template.version, hashSnapshot(template), coverage.version, hashSnapshot(coverage), releaseEventId,
      effectiveTo, JSON.stringify(withdrawn), JSON.stringify(template), JSON.stringify(coverage), sourceCheckId,
      sampleEvidenceIds, operator, operatorGrant, 'Synthetic PG16 withdrawal replay test only.', withdrawalAt,
      manifestId, manifestVersion, manifestContentSha, industryAttestationId, technicalAttestationId]);
    assert.deepEqual(await revalidateProductionRulePackPin(client, selected.pin, selected.pin.applicabilityContext),
      { status: 'blocked', reasons: ['production_rule_pack_withdrawn'] });
    if (gateCtx) {
      assert.ok((await preflightRuleReasons(client, operator, projectId, gateCtx.run.input_hash,
        selectionRequest, contextPin)).includes('rule_pack:production_rule_pack_withdrawn'));
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

test('live PostgreSQL 16 rejects fabricated rollback targets and revoked sample authority or reviewer grants', {
  skip: !databaseUrl && 'set PRODUCTION_RULE_PACK_SELECTOR_TEST_DATABASE_URL to a migrated PostgreSQL 16 template',
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const suffix = Math.random().toString(16).slice(2, 10);
  const users = [`operator_${suffix}`, `industry_${suffix}`, `technical_${suffix}`, `admin_${suffix}`];
  const [operator, industry, technical, admin] = users;
  const grants = [`grant_operator_${suffix}`, `grant_industry_${suffix}`, `grant_technical_${suffix}`];
  const [operatorGrant, industryGrant, technicalGrant] = grants;
  const hash = 'b'.repeat(64);
  try {
    await client.query('BEGIN');
    // Fixture publication dates come from UTC ISO strings; keep the SQL event date in the same timezone.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const rejectsWithSavepoint = async (sql: string, values: unknown[], pattern: RegExp, name: string) => {
      const safeName = name.replaceAll(/[^a-zA-Z0-9_]/g, '_');
      await client.query(`SAVEPOINT ${safeName}`);
      await assert.rejects(client.query(sql, values), pattern);
      await client.query(`ROLLBACK TO SAVEPOINT ${safeName}`);
      await client.query(`RELEASE SAVEPOINT ${safeName}`);
    };
    for (const [index, id] of users.entries()) await client.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `u${id}`.slice(0, 32)]);
    await insertScopedGrant(client, { id: operatorGrant, userId: operator, grantorId: admin, role: 'rule_pack_operator',
      market: 'sse', offering: 'public_all', instruments: ['synthetic-bond'], documentStages: ['registration'], suffix });
    await insertScopedGrant(client, { id: industryGrant, userId: industry, grantorId: admin, role: 'rule_pack_industry_reviewer',
      market: 'sse', offering: 'public_all', instruments: ['synthetic-bond'], documentStages: ['registration'], suffix });
    await insertScopedGrant(client, { id: technicalGrant, userId: technical, grantorId: admin, role: 'rule_pack_technical_reviewer',
      market: 'sse', offering: 'public_all', instruments: ['synthetic-bond'], documentStages: ['registration'], suffix });

    // 0073 requires an exactly pinned frozen manifest and two approvals before the
    // 0036 snapshot gates can run. Seed one synthetic binding reused by every
    // negative case; the per-case mutation only touches pack_snapshot.
    const syntheticPackId = 'synthetic-pack';
    const manifestOwnerGrant = operatorGrant;
    const manifestOwner = operator;
    const manifestScope = {
      market: 'sse', offering: 'public_all', instruments: ['synthetic-bond'], document_stages: ['registration'],
      applicable_from: '2026-01-01', applicable_until: null,
      issuer_scopes: reviewedScope(`synthetic-issuer-scope-${suffix}`, 'a'.repeat(64)),
      investor_scopes: reviewedScope(`synthetic-investor-scope-${suffix}`, 'b'.repeat(64)),
      industry_codes: reviewedScope(`synthetic-industry-scope-${suffix}`, 'c'.repeat(64)),
      special_feature_scope: reviewedScope(`synthetic-feature-scope-${suffix}`, 'd'.repeat(64)),
    };
    const manifestContent = {
      contract_version: 'production-review-content-v1', hash_domain: 'bondbuddy:production-review-content:v1',
      rule_pack: { id: syntheticPackId, version: '1', sha256: 'a'.repeat(64) },
      chapter_template: { id: 'synthetic-template', version: 'template.1', sha256: '2'.repeat(64) },
      coverage_manifest: { id: 'synthetic-coverage', version: 'coverage.1', sha256: '3'.repeat(64) },
      applicability_scope: manifestScope, source_date_evidence: [], authorized_real_sample_evidence: [],
    };
    const manifestContentSha = hashSnapshot(manifestContent);
    await client.query(`INSERT INTO bb_production_review_manifests
      (manifest_id,manifest_version,content_sha256,content,request_id,request_hash,frozen_by_user_id,frozen_by_grant_id)
      VALUES($1,1,$2,$3::jsonb,$4,$5,$6,$7)`,
    [syntheticPackId, manifestContentSha, JSON.stringify(manifestContent), `synthetic-manifest-${suffix}`,
      hashSnapshot({ synthetic: 'manifest-request', suffix }), manifestOwner, manifestOwnerGrant]);
    const industryAttestationId = `synthetic-industry-attestation-${suffix}`;
    const technicalAttestationId = `synthetic-technical-attestation-${suffix}`;
    const attestationInsert = `INSERT INTO bb_production_review_attestation_events
      (attestation_event_id,manifest_id,manifest_version,content_sha256,request_id,request_hash,reviewer_role,reviewer_user_id,
       grant_id,decision,reason,evidence,reviewed_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,'approve',$9,$10::jsonb,'2026-09-24T00:00:00Z')`;
    await client.query(attestationInsert, [industryAttestationId, syntheticPackId, manifestContentSha,
      `synthetic-industry-attest-${suffix}`, hashSnapshot({ synthetic: 'industry-attest', suffix }), 'industry', industry,
      industryGrant, 'Synthetic manifest approval only.', JSON.stringify({ synthetic: true })]);
    await client.query(attestationInsert, [technicalAttestationId, syntheticPackId, manifestContentSha,
      `synthetic-technical-attest-${suffix}`, hashSnapshot({ synthetic: 'technical-attest', suffix }), 'technical', technical,
      technicalGrant, 'Synthetic manifest approval only.', JSON.stringify({ synthetic: true })]);

    const rowSnapshot = { pack_id: 'synthetic-pack', version: '1', status: 'published',
      release: { channel: 'production', content_hash: 'a'.repeat(64) },
      scope: { market: 'sse', offering: 'public_all', instruments: ['synthetic-bond'], document_stages: ['registration'] },
      validity: { effective_from: '2026-01-01', effective_to: null } };

    const assertProductionGateRejects = async (label: string, mutate: (snapshot: Record<string, any>, occurredAt: string) => void, pattern: RegExp) => {
      const occurredAt = new Date(Date.now() + 60_000).toISOString();
      const releaseHash = 'a'.repeat(64);
      const snapshot: Record<string, any> = {
        ...rowSnapshot,
        validity: { published_on: occurredAt.slice(0, 10), effective_from: '2026-01-01', effective_to: null },
        sources: [{ source_id: 'source-1', kind: 'formal_rule', published_on: '2025-01-01', effective_from: '2025-01-01', legal_effective_date_basis: 'explicit_text', effective_date_derivation_evidence: [{ kind: 'synthetic_clause', value: 'clause 1' }],
          effective_to: null, verified_by: 'synthetic-reviewer', verified_at: '2026-09-24T00:00:00Z' }],
        rules: [{ enabled: true, enforcement: 'soft_check' }],
        sample_suite: { data_classification: 'authorized_real', cases: [
          { case_id: 'positive', polarity: 'positive', result: 'passed', reviewed_at: '2026-09-24T00:00:00Z' },
          { case_id: 'negative', polarity: 'negative', result: 'passed', reviewed_at: '2026-09-24T00:00:00Z' },
          { case_id: 'boundary', polarity: 'boundary', result: 'passed', reviewed_at: '2026-09-24T00:00:00Z' },
        ] },
        reviews: [
          { reviewer_id: industry, reviewer_role: 'industry_reviewer', reviewed_at: '2026-09-24T00:00:00Z', source_verified: true, scope_verified: true, samples_verified: true },
          { reviewer_id: technical, reviewer_role: 'technical_reviewer', reviewed_at: '2026-09-24T00:00:00Z', source_verified: true, scope_verified: true, samples_verified: true },
        ],
        release: { channel: 'production', content_hash: releaseHash, released_by: operator, released_at: occurredAt, reason: `synthetic ${label}` },
      };
      mutate(snapshot, occurredAt);
      await rejectsWithSavepoint(`INSERT INTO bb_rule_pack_production_release_events
        (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
         coverage_version,coverage_hash,market,offering,instruments,document_stages,effective_from,effective_to,
         pack_snapshot,template_snapshot,coverage_snapshot,operator_user_id,operator_grant_id,industry_reviewer_user_id,
         industry_reviewer_grant_id,technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at,
         manifest_id,manifest_version,manifest_content_sha256,industry_attestation_event_id,technical_attestation_event_id)
        VALUES ($1,'synthetic-pack',$2,$3,1,'production_release','1',$4,'template.1',$5,'coverage.1',$6,
         'sse','public_all',ARRAY['synthetic-bond'],ARRAY['registration'],'2026-01-01',NULL,$7::jsonb,
         '{"rule_pack_id":"synthetic-pack","version":"template.1","market":"sse","offering":"public_all"}'::jsonb,
         '{"rule_pack_id":"synthetic-pack","version":"coverage.1","open_blockers":[],"items":[{"disposition":"covered"}]}'::jsonb,
         $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [`unsafe-${label}-${suffix}`, `unsafe-request-${label}-${suffix}`, '9'.repeat(64), releaseHash,
        '2'.repeat(64), '3'.repeat(64), JSON.stringify(snapshot), operator, operatorGrant, industry,
        industryGrant, technical, technicalGrant, `synthetic ${label}`, occurredAt,
        syntheticPackId, 1, manifestContentSha, industryAttestationId, technicalAttestationId], pattern, `publish_gate_${label}`);
    };
    await assertProductionGateRejects('unverified-source', (snapshot) => { snapshot.sources[0]!.kind = 'unverified_lead'; }, /expired or unverified sources cannot be production published/);
    await assertProductionGateRejects('publication-date-mismatch', (snapshot) => { snapshot.validity.published_on = '2026-09-24'; }, /pack publication date must match release event date/);
    await assertProductionGateRejects('disabled-rule', (snapshot) => { snapshot.rules[0]!.enabled = false; }, /disabled or research-only rules cannot be production published/);
    await assertProductionGateRejects('research-only-rule', (snapshot) => { snapshot.rules[0]!.enforcement = 'research_only'; }, /disabled or research-only rules cannot be production published/);
    await assertProductionGateRejects('failed-sample', (snapshot) => { snapshot.sample_suite.cases[1]!.result = 'failed'; }, /production release requires passed positive negative and boundary samples/);
    await assertProductionGateRejects('future-review', (snapshot, occurredAt) => { snapshot.reviews[0]!.reviewed_at = new Date(Date.parse(occurredAt) + 60_000).toISOString(); }, /future review attestations cannot authorize a production release/);
    await assertProductionGateRejects('future-sample', (snapshot, occurredAt) => { snapshot.sample_suite.cases[0]!.reviewed_at = new Date(Date.parse(occurredAt) + 60_000).toISOString(); }, /production release requires passed positive negative and boundary samples/);

    await rejectsWithSavepoint(`INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
       coverage_version,coverage_hash,target_event_id,market,offering,instruments,
       document_stages,effective_from,pack_snapshot,template_snapshot,coverage_snapshot,operator_user_id,operator_grant_id,
       industry_reviewer_user_id,industry_reviewer_grant_id,technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at)
      VALUES ('fake-rollback-${suffix}','synthetic-pack','fake-rollback-${suffix}',$1,1,'production_rollback','1',$2,
       'template.1',$2,'coverage.1',$2,'does-not-exist','sse','public_all',ARRAY['synthetic-bond'],ARRAY['registration'],'2026-01-01',$3::jsonb,
       '{"rule_pack_id":"synthetic-pack","version":"1","market":"sse","offering":"public_all"}'::jsonb,
       '{"rule_pack_id":"synthetic-pack","open_blockers":[]}'::jsonb,$4,$5,$6,$7,$8,$9,'negative fake rollback test',now())`,
     ['c'.repeat(64), 'a'.repeat(64), JSON.stringify(rowSnapshot), operator, operatorGrant, industry, industryGrant, technical, technicalGrant],
     /rollback must retain the exact immutable historical attestation binding/, 'fake_rollback');

    await client.query(`INSERT INTO bb_rule_pack_sample_authorizations
      (id,material_sha256,authorization_document_sha256,authorization_scope,market,offering,authorized_by_user_id,authorizer_grant_id,authorized_at)
      VALUES ('auth-revoked-${suffix}',$1,$2,'rule_pack_validation','sse','public_all',$3,$4,now())`, [hash, 'd'.repeat(64), operator, operatorGrant]);
    await client.query(`UPDATE bb_rule_pack_sample_authorizations SET revoked_at=now() WHERE id='auth-revoked-${suffix}'`);
    await rejectsWithSavepoint(`INSERT INTO bb_rule_pack_production_sample_evidence
      (id,sample_case_id,pack_id,pack_version,pack_hash,polarity,material_sha256,authorization_id,market,offering,
       expected_outcome,observed_outcome,source_anchor,reviewer_user_id,reviewer_grant_id,reviewed_at)
      VALUES ('sample-revoked-${suffix}','case-1','synthetic-pack','1',$1,'positive',$2,'auth-revoked-${suffix}',
       'sse','public_all','pass','pass','synthetic anchor',$3,$4,now())`, ['a'.repeat(64), hash, industry, industryGrant],
    /active exact-hash sample authorization required/, 'revoked_sample_authorization');

    await client.query(`INSERT INTO bb_rule_pack_sample_authorizations
      (id,material_sha256,authorization_document_sha256,authorization_scope,market,offering,authorized_by_user_id,authorizer_grant_id,authorized_at)
      VALUES ('auth-reviewer-${suffix}',$1,$2,'rule_pack_validation','sse','public_all',$3,$4,now())`, ['e'.repeat(64), 'f'.repeat(64), operator, operatorGrant]);
    await client.query(`UPDATE bb_rule_pack_production_reviewer_grants SET revoked_at=now() WHERE id=$1`, [industryGrant]);
    await rejectsWithSavepoint(`INSERT INTO bb_rule_pack_production_sample_evidence
      (id,sample_case_id,pack_id,pack_version,pack_hash,polarity,material_sha256,authorization_id,market,offering,
       expected_outcome,observed_outcome,source_anchor,reviewer_user_id,reviewer_grant_id,reviewed_at)
      VALUES ('sample-reviewer-${suffix}','case-2','synthetic-pack','1',$1,'negative',$2,'auth-reviewer-${suffix}',
       'sse','public_all','issue','issue','synthetic anchor',$3,$4,now())`, ['a'.repeat(64), 'e'.repeat(64), industry, industryGrant],
    /active rule-pack reviewer grant required for sample evidence/, 'revoked_reviewer');

    // Seed only a rolled-back fixture row in this isolated test database to
    // exercise the real append-only withdrawal trigger and selector query.
    const seedId = `synthetic-seeded-release-${suffix}`;
    const templateSnapshot = { rule_pack_id: 'synthetic-pack', version: 'template.1', market: 'sse', offering: 'public_all' };
    const coverageSnapshot = { rule_pack_id: 'synthetic-pack', version: 'coverage.1', open_blockers: [], items: [] };
    const releaseAt = new Date(Date.now() + 60_000).toISOString();
    const releasedSnapshot = { ...rowSnapshot, validity: { ...rowSnapshot.validity, published_on: releaseAt.slice(0, 10) },
      release: { ...rowSnapshot.release, released_by: operator,
        released_at: releaseAt, reason: 'rolled-back synthetic fixture' } };
    await client.query('ALTER TABLE bb_rule_pack_production_release_events DISABLE TRIGGER bb_rule_pack_production_event_guard');
    // The seeded legacy row has no manifest binding and the industry grant is
    // already revoked above, so also suspend the 0073 release binding guard for
    // this rolled-back fixture; the withdrawal below still runs both guards.
    await client.query('ALTER TABLE bb_rule_pack_production_release_events DISABLE TRIGGER bb_rule_pack_production_event_attestation_guard');
    await client.query(`INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
       coverage_version,coverage_hash,market,offering,instruments,document_stages,effective_from,effective_to,
       pack_snapshot,template_snapshot,coverage_snapshot,operator_user_id,operator_grant_id,industry_reviewer_user_id,
       industry_reviewer_grant_id,technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at)
      VALUES ($1,'synthetic-pack',$2,$3,1,'production_release','1',$4,'template.1',$5,'coverage.1',$6,
       'sse','public_all',ARRAY['synthetic-bond'],ARRAY['registration'],'2026-01-01',NULL,$7::jsonb,$8::jsonb,$9::jsonb,
       $10,$11,$12,$13,$14,$15,'rolled-back synthetic fixture',$16)`,
    [seedId, `request-${suffix}`, '1'.repeat(64), 'a'.repeat(64), '2'.repeat(64), '3'.repeat(64),
      JSON.stringify(releasedSnapshot), JSON.stringify(templateSnapshot), JSON.stringify(coverageSnapshot),
      operator, operatorGrant, industry, industryGrant, technical, technicalGrant, releaseAt]);
    await client.query('ALTER TABLE bb_rule_pack_production_release_events ENABLE TRIGGER bb_rule_pack_production_event_attestation_guard');
    await client.query('ALTER TABLE bb_rule_pack_production_release_events ENABLE TRIGGER bb_rule_pack_production_event_guard');
    const withdrawnAt = new Date(Date.parse(releaseAt) + 60_000).toISOString();
    const withdrawnSnapshot = { ...releasedSnapshot, status: 'withdrawn', withdrawal: {
      withdrawn_by: operator, withdrawn_at: withdrawnAt, reason: 'rolled-back synthetic withdrawal fixture',
    } };
    await client.query(`INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,template_version,template_hash,
       coverage_version,coverage_hash,target_event_id,market,offering,instruments,document_stages,effective_from,effective_to,
       pack_snapshot,template_snapshot,coverage_snapshot,source_check_ids,sample_evidence_ids,operator_user_id,operator_grant_id,
       reason,occurred_at)
      VALUES ($1,'synthetic-pack',$2,$3,2,'production_withdrawal','1',$4,'template.1',$5,'coverage.1',$6,$7,
       'sse','public_all',ARRAY['synthetic-bond'],ARRAY['registration'],'2026-01-01',NULL,$8::jsonb,$9::jsonb,$10::jsonb,
       ARRAY[]::text[],ARRAY[]::text[],$11,$12,'rolled-back synthetic withdrawal fixture',$13)`,
    [`synthetic-withdrawal-${suffix}`, `withdraw-request-${suffix}`, '4'.repeat(64), 'a'.repeat(64), '2'.repeat(64),
      '3'.repeat(64), seedId, JSON.stringify(withdrawnSnapshot), JSON.stringify(templateSnapshot),
      JSON.stringify(coverageSnapshot), operator, operatorGrant, withdrawnAt]);
    assert.deepEqual(await selectProductionRulePack(client as never, request), {
      status: 'blocked', reasons: ['production_rule_pack_withdrawn'],
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
