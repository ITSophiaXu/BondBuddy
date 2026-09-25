import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  nafmiiMtnDraftRulePack,
  nafmiiMtnChapterTemplate,
  nafmiiMtnCoverageManifest,
  publishRulePack,
  rulePackContentHash,
  type ReviewAttestation,
  type RulePack,
} from '@bondbuddy/domain';
import { isolatedTestDatabase } from './test-database.js';
import { selectProductionRulePack, type ProductionRulePackRequest } from './rule-pack-production-selector.js';

const databaseUrl = await isolatedTestDatabase('PRODUCTION_RULE_PACK_SELECTOR_TEST_DATABASE_URL');
const request: ProductionRulePackRequest = {
  market: 'sse', offering: 'public_all', instrument: 'synthetic-corporate-bond',
  documentStage: 'registration', issuerScope: 'synthetic_issuer', asOf: '2026-09-25',
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

function fixture(): { pack: RulePack; template: typeof nafmiiMtnChapterTemplate; coverage: typeof nafmiiMtnCoverageManifest } {
  const draft = structuredClone(nafmiiMtnDraftRulePack) as RulePack;
  draft.pack_id = 'synthetic-selector-pack';
  draft.version = 'synthetic.1';
  draft.scope = { market: 'sse', offering: 'public_all', instruments: ['synthetic-corporate-bond'], document_stages: ['registration'], issuer_scopes: ['synthetic_issuer'] };
  draft.validity = { published_on: null, effective_from: '2026-01-01', effective_to: null, transition_terms: [] };
  draft.sources = [{ ...draft.sources[0]!, source_id: 'synthetic-source', kind: 'formal_rule', official_url: 'https://example.invalid/source', document_hash: 'a'.repeat(64), published_on: '2025-01-01', effective_from: '2026-01-01', effective_to: null, verified_by: 'synthetic-reviewer', verified_at: '2026-09-24T00:00:00Z' }];
  draft.rules = [{ ...draft.rules[0]!, rule_id: 'synthetic-rule', source_ref_ids: ['synthetic-source'], enabled: true, enforcement: 'hard_block', outputs: { when_met: 'pass', when_not_met: 'issue', severity: 'blocking' } }];
  draft.sample_suite = { suite_id: 'synthetic-samples', version: 'synthetic.1', data_classification: 'authorized_real', cases: draft.sample_suite.cases.map((item, index) => ({ ...item, case_id: `synthetic-case-${index}`, evidence_ref: 'synthetic:test-only', result: 'passed', reviewed_by: 'synthetic-reviewer', reviewed_at: '2026-09-24T00:00:00Z' })) };
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

test('selector delegates applicability and blocks when investor, industry, or feature evidence is absent', async () => {
  let call = 0;
  const result = await selectProductionRulePack({ query: async () => (++call === 1
    ? { rows: [registryRow()] }
    : { rows: [{ reviewers_active: true, sources_current: true, samples_complete: true }] }) } as never, request);
  assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_capability_not_ready'] });
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
    const result = await selectProductionRulePack(pool, request);
    assert.deepEqual(result, { status: 'blocked', reasons: ['production_rule_pack_registry_empty'] });
    await assert.rejects(pool.query(`INSERT INTO bb_rule_pack_production_release_events
      (id,pack_id,request_id,request_hash,sequence,action,pack_version,content_hash,market,offering,instruments,document_stages,
       effective_from,pack_snapshot,operator_user_id,operator_grant_id,reason,occurred_at)
      VALUES ('synthetic-no-proof','synthetic-pack','synthetic-request',$1,1,'production_release','1',$1,
       'sse','public_all',ARRAY['synthetic-instrument'],ARRAY['registration'],'2026-01-01','{}'::jsonb,
       'synthetic-user','synthetic-grant','negative guard test',now())`, ['a'.repeat(64)]), /active scoped production operator grant|required|production/i);
  } finally { await pool.end(); }
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
    const rejectsWithSavepoint = async (sql: string, values: unknown[], pattern: RegExp, name: string) => {
      const safeName = name.replaceAll(/[^a-zA-Z0-9_]/g, '_');
      await client.query(`SAVEPOINT ${safeName}`);
      await assert.rejects(client.query(sql, values), pattern);
      await client.query(`ROLLBACK TO SAVEPOINT ${safeName}`);
      await client.query(`RELEASE SAVEPOINT ${safeName}`);
    };
    for (const [index, id] of users.entries()) await client.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `u${id}`.slice(0, 32)]);
    await client.query(`INSERT INTO bb_rule_pack_production_reviewer_grants(id,user_id,role,market,offering,granted_by,reason_code)
      VALUES ($1,$2,'rule_pack_operator','sse','public_all',$5,'test_fixture'),
             ($3,$4,'rule_pack_industry_reviewer','sse','public_all',$5,'test_fixture'),
             ($6,$7,'rule_pack_technical_reviewer','sse','public_all',$5,'test_fixture')`,
    [operatorGrant, operator, industryGrant, industry, admin, technicalGrant, technical]);

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
        sources: [{ source_id: 'source-1', kind: 'formal_rule', published_on: '2025-01-01', effective_from: '2025-01-01',
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
         industry_reviewer_grant_id,technical_reviewer_user_id,technical_reviewer_grant_id,reason,occurred_at)
        VALUES ($1,'synthetic-pack',$2,$3,1,'production_release','1',$4,'template.1',$5,'coverage.1',$6,
         'sse','public_all',ARRAY['synthetic-bond'],ARRAY['registration'],'2026-01-01',NULL,$7::jsonb,
         '{"rule_pack_id":"synthetic-pack","version":"template.1","market":"sse","offering":"public_all"}'::jsonb,
         '{"rule_pack_id":"synthetic-pack","version":"coverage.1","open_blockers":[],"items":[{"disposition":"covered"}]}'::jsonb,
         $8,$9,$10,$11,$12,$13,$14,$15)`,
      [`unsafe-${label}-${suffix}`, `unsafe-request-${label}-${suffix}`, '9'.repeat(64), releaseHash,
        '2'.repeat(64), '3'.repeat(64), JSON.stringify(snapshot), operator, operatorGrant, industry,
        industryGrant, technical, technicalGrant, `synthetic ${label}`, occurredAt], pattern, `publish_gate_${label}`);
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
    /rollback must replay an exact immutable historical production release/, 'fake_rollback');

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
