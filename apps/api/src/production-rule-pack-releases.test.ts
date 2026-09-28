import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import {
  publishRulePackBundle, rulePackContentHash, type ChapterTemplate, type CoverageManifest,
  type RulePack,
} from '@bondbuddy/domain';
import {
  productionSnapshotHash, registerProductionComponentSnapshots,
} from '@bondbuddy/rule-pack-registry';

const databaseUrl = await isolatedTestDatabase('PRODUCTION_RULE_PACK_RELEASE_TEST_DATABASE_URL');
const origin = 'http://bondbuddy.test';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value)!;
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const h = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

test('synthetic PostgreSQL 16 production release binds exact approvals, snapshots, evidence and actor outbox', {
  skip: !databaseUrl && 'set PRODUCTION_RULE_PACK_RELEASE_TEST_DATABASE_URL to an isolated PostgreSQL 16 database migrated through 0073',
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl! });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const user = (role: string) => `prw-${role}-${suffix}`;
  const operator = user('operator'), industry = user('industry'), technical = user('technical'), grantor = user('grantor');
  const grants = { operator: `prw-og-${suffix}`, industry: `prw-ig-${suffix}`, technical: `prw-tg-${suffix}` };
  let activeUser = operator;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: activeUser, csrfVerified: true }) });
  const send = async (method: string, url: string, payload?: unknown): Promise<any> => app.inject({ method: method as any,
    url, headers: { origin }, ...(payload === undefined ? {} : { payload: payload as any }) });
  const id = `synthetic-release-${suffix}`;
  const scope = {
    market: 'sse', offering: 'private', instruments: ['ordinary-company-bond'], document_stages: ['issuance'],
    applicable_from: '2026-01-01', applicable_until: null,
    issuer_scopes: { mode: 'reviewed_unrestricted', evidence_id: `scope-issuer-${suffix}`, evidence_version: 1, evidence_sha256: h(1) },
    investor_scopes: { mode: 'reviewed_unrestricted', evidence_id: `scope-investor-${suffix}`, evidence_version: 1, evidence_sha256: h(2) },
    industry_codes: { mode: 'reviewed_unrestricted', evidence_id: `scope-industry-${suffix}`, evidence_version: 1, evidence_sha256: h(3) },
    special_feature_scope: { mode: 'reviewed_unrestricted', evidence_id: `scope-feature-${suffix}`, evidence_version: 1, evidence_sha256: h(4) },
    exceptions: [], uncovered_items: [],
  };
  const pack = JSON.parse(readFileSync(new URL('../../../packages/domain/examples/synthetic-rule-pack.json', import.meta.url), 'utf8')) as RulePack;
  pack.pack_id = id; pack.version = '1';
  pack.scope = { market: 'sse', offering: 'private', instruments: ['ordinary-company-bond'], document_stages: ['issuance'], issuer_scopes: ['domestic-company'] };
  pack.validity = { ...pack.validity, published_on: null, effective_from: '2026-01-01', effective_to: null };
  const sourceId = `source-${suffix}`;
  const sourceHash = h(5), sourceDocumentHash = h(6);
  pack.sources = [{ ...pack.sources[0]!, source_id: sourceId, kind: 'formal_rule', authority: 'Synthetic test authority',
    document_title: 'Synthetic release writer fixture', source_version: 'synthetic-1', official_url: 'https://example.invalid/synthetic',
    document_hash: sourceDocumentHash, clause_locator: 'synthetic clause', exact_quote: 'Synthetic only; not legal evidence.',
    published_on: '2025-12-01', effective_from: '2026-01-01', effective_to: null,
    legal_effective_date_basis: 'explicit_text', effective_date_derivation_evidence: [{ kind: 'synthetic_clause', value: 'clause 1' }],
    verified_by: industry, verified_at: '2026-09-28T00:00:00Z' }];
  const existingRule = pack.rules[0]!;
  pack.rules = [{ ...existingRule, rule_id: `rule-${suffix}`, enabled: true, enforcement: 'soft_check', source_ref_ids: [sourceId],
    applicability: { ...existingRule.applicability, document_stages: ['issuance'], issuer_scopes: ['domestic-company'] } }];
  pack.sample_suite.data_classification = 'authorized_real';
  pack.sample_suite.cases = pack.sample_suite.cases.map(testCase => {
    const exampleKey = `${testCase.polarity}_examples` as 'positive_examples' | 'negative_examples' | 'boundary_examples';
    const example = pack.rules[0]![exampleKey][0]!;
    return { ...testCase, case_id: `case-${testCase.polarity}-${suffix}`, evidence_ref: example.evidence_ref,
      result: 'passed', reviewed_by: industry, reviewed_at: '2026-09-28T00:00:00Z' };
  });
  const template: ChapterTemplate = { schema_version: 'chapter-template-v1', template_id: `template-${suffix}`, version: '1',
    rule_pack_id: id, market: 'sse', offering: 'private', document_stages: ['issuance'], chapters: [
      { chapter_id: `chapter-${suffix}`, title: 'Synthetic test chapter', form_refs: [`form-${suffix}`], source_ref_ids: [sourceId],
        required_fields: [], applicability: 'Synthetic only' }] };
  const coverage: CoverageManifest = { schema_version: 'capability-coverage-v1', manifest_id: `coverage-${suffix}`, version: '1',
    rule_pack_id: id, assessed_at: '2026-09-28T00:00:00Z', open_blockers: [], items: [
      { item_id: `coverage-item-${suffix}`, area: 'Synthetic only', disposition: 'covered', document_stages: ['issuance'],
        source_ref_ids: [sourceId], rationale: 'Synthetic test fixture only.' }] };
  const packHash = rulePackContentHash(pack), templateHash = productionSnapshotHash(template), coverageHash = productionSnapshotHash(coverage);
  const sourceEvidence = { source_evidence_id: sourceId, source_check_sha256: sourceHash, source_document_sha256: sourceDocumentHash,
    source_kind: 'binding_rule', document_revision_date: null, signed_date: null, official_publication_date: '2025-12-01',
    acquired_date: '2026-09-28', legal_effective_date: '2026-01-01', legal_expiry_date: null,
    legal_effective_date_basis: 'explicit_text', effective_date_derivation_evidence: [{ kind: 'synthetic_clause', value: 'clause 1' }],
    transition_from_date: null, transition_until_date: null, transition_evidence: [],
    applicability_basis: { basis_id: `basis-${suffix}`, basis_version: 1, basis_sha256: h(7), source_document_sha256: sourceDocumentHash,
      applicability_scope: scope, time_basis: 'Synthetic as-of date only.', locator: { kind: 'synthetic_clause', value: 'clause 1' } },
    approved_method_window: null, locators: [{ kind: 'synthetic_clause', value: 'clause 1' }] };
  const cases = [...pack.sample_suite.cases].sort((a, b) => `sample-${a.polarity}-${suffix}`.localeCompare(`sample-${b.polarity}-${suffix}`));
  const samples = cases.map((sample, index) => ({ sample_evidence_id: `sample-${sample.polarity}-${suffix}`,
    sample_evidence_sha256: h(10 + index), authorization_evidence_id: `authorization-${sample.polarity}-${suffix}`,
    authorization_evidence_sha256: h(20 + index), sample_case_id: sample.case_id, polarity: sample.polarity,
    expected_outcome_sha256: h(30 + index), reviewed_result_sha256: h(40 + index) }));
  const content = { contract_version: 'production-review-content-v1', hash_domain: 'bondbuddy:production-review-content:v1',
    canonicalization: 'utf8-json-sorted-object-keys-preserve-declared-array-order-v1',
    rule_pack: { id, version: '1', sha256: packHash }, chapter_template: { id: template.template_id, version: '1', sha256: templateHash },
    coverage_manifest: { id: coverage.manifest_id, version: '1', sha256: coverageHash }, applicability_scope: scope,
    source_date_evidence: [sourceEvidence], authorized_real_sample_evidence: samples };

  const insertGrant = async (grantId: string, grantee: string, role: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO bb_rule_pack_production_reviewer_grants
      (id,user_id,role,market,offering,granted_by,reason_code) VALUES($1,$2,$3,'sse','private',$4,'synthetic_test')`,
        [grantId, grantee, role, grantor]);
      const values = { instruments: scope.instruments, document_stages: scope.document_stages,
        issuer_scopes: scope.issuer_scopes, investor_scopes: scope.investor_scopes, industry_codes: scope.industry_codes,
        special_feature_scope: scope.special_feature_scope };
      await client.query(`INSERT INTO bb_rule_pack_production_grant_scopes
      (grant_id,instruments,document_stages,issuer_scopes,investor_scopes,industry_codes,special_feature_scope,scope_hash)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8)`, [grantId, values.instruments, values.document_stages,
        json(values.issuer_scopes), json(values.investor_scopes), json(values.industry_codes), json(values.special_feature_scope), hash(values)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const json = (value: unknown) => JSON.stringify(value);

  const makeIndustryEvidence = () => ({ source_effectivity_applicability: [{ source_evidence_id: sourceId,
      source_check_sha256: sourceHash, conclusion: 'applicable', reason: 'Synthetic test only.',
      evidence_refs: [{ evidence_id: `industry-source-${suffix}`, evidence_sha256: h(50) }] }],
    chapter_boundaries: [{ chapter_id: `chapter-${suffix}`, boundary: 'included', reason: 'Synthetic test only.',
      evidence_refs: [{ evidence_id: `industry-chapter-${suffix}`, evidence_sha256: h(51) }] }],
    exceptions_and_uncovered: [], sample_conclusions: samples.map((sample, index) => ({ sample_case_id: sample.sample_case_id,
      sample_evidence_id: sample.sample_evidence_id, conclusion: 'approve', reason: 'Synthetic test only.',
      evidence_refs: [{ evidence_id: `industry-sample-${index}-${suffix}`, evidence_sha256: h(52 + index) }] })) });
  const makeTechnicalEvidence = () => ({ checker_version_or_commit: 'synthetic-checker-v1', converter_version_or_commit: 'synthetic-converter-v1',
    test_evidence: [{ evidence_id: `technical-test-${suffix}`, evidence_sha256: h(60) }],
    template_coverage_consistency: { chapter_template_sha256: templateHash, coverage_manifest_sha256: coverageHash,
      result: 'consistent', evidence_refs: [{ evidence_id: `technical-consistency-${suffix}`, evidence_sha256: h(61) }] } });

  try {
    const phoneSuffix = [...suffix].map(character => Number.parseInt(character, 16) % 10).join('');
    for (const [index, person] of [operator, industry, technical, grantor].entries())
      await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)', [person, `+1555${phoneSuffix}${index}`]);
    await insertGrant(grants.operator, operator, 'rule_pack_operator');
    await insertGrant(grants.industry, industry, 'rule_pack_industry_reviewer');
    await insertGrant(grants.technical, technical, 'rule_pack_technical_reviewer');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await registerProductionComponentSnapshots(client as any, {
        rule_pack: { kind: 'rule_pack', id, version: '1', sha256: packHash },
        chapter_template: { kind: 'chapter_template', id: template.template_id, version: '1', sha256: templateHash },
        coverage_manifest: { kind: 'coverage_manifest', id: coverage.manifest_id, version: '1', sha256: coverageHash },
      }, { rule_pack: pack, chapter_template: template, coverage_manifest: coverage });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

    await pool.query(`INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,document_hash,
       clause_locator,exact_quote,checked_at,effective_from,effective_to,verifier_user_id,verifier_grant_id,
       document_revision_date,signed_date,official_publication_date,acquired_date,legal_effective_date_basis,
       effective_date_derivation_evidence,transition_evidence,applicability_basis,source_check_sha256)
      VALUES($1,$2,'1',$3,$1,'Synthetic test authority','https://example.invalid/synthetic','synthetic-1','sse','private',$4,
       'synthetic clause','Synthetic only; not legal evidence.',now(),'2026-01-01',NULL,$5,$6,NULL,NULL,'2025-12-01','2026-09-28',
       'explicit_text',$7::jsonb,'[]'::jsonb,$8::jsonb,$9)`, [sourceId, id, packHash, sourceDocumentHash, industry, grants.industry,
      json(sourceEvidence.effective_date_derivation_evidence), json(sourceEvidence.applicability_basis), sourceHash]);
    for (const sample of samples) {
      const sampleCase = pack.sample_suite.cases.find(row => row.case_id === sample.sample_case_id)!;
      const sampleIndex = samples.indexOf(sample);
      const exampleKey = `${sample.polarity}_examples` as 'positive_examples' | 'negative_examples' | 'boundary_examples';
      const expectedOutcome = pack.rules[0]![exampleKey][0]!.expected_outcome;
      await pool.query(`INSERT INTO bb_rule_pack_sample_authorizations
        (id,material_sha256,authorization_document_sha256,authorization_scope,market,offering,authorized_by_user_id,
         authorizer_grant_id,authorized_at,authorization_evidence_sha256)
        VALUES($1,$2,$3,'rule_pack_validation','sse','private',$4,$5,now(),$6)`,
      [sample.authorization_evidence_id, h(70 + sampleIndex), h(80 + sampleIndex), operator, grants.operator, sample.authorization_evidence_sha256]);
      await pool.query(`INSERT INTO bb_rule_pack_production_sample_evidence
        (id,sample_case_id,pack_id,pack_version,pack_hash,polarity,material_sha256,authorization_id,market,offering,
         expected_outcome,observed_outcome,source_anchor,reviewer_user_id,reviewer_grant_id,reviewed_at,
         sample_evidence_sha256,expected_outcome_sha256,reviewed_result_sha256)
        VALUES($1,$2,$3,'1',$4,$5,$6,$7,'sse','private',$8,$8,'synthetic anchor',$9,$10,now(),$11,$12,$13)`,
      [sample.sample_evidence_id, sampleCase.case_id, id, packHash, sample.polarity, h(70 + sampleIndex), sample.authorization_evidence_id,
        expectedOutcome, industry, grants.industry, sample.sample_evidence_sha256, sample.expected_outcome_sha256, sample.reviewed_result_sha256]);
    }
    const sampleGuardDiagnostic = await pool.query(`SELECT c->>'case_id' AS case_id, EXISTS (
      SELECT 1 FROM bb_rule_pack_production_sample_evidence s
      JOIN bb_rule_pack_production_reviewer_grants g ON g.id=s.reviewer_grant_id AND g.user_id=s.reviewer_user_id
      JOIN bb_rule_pack_sample_authorizations a ON a.id=s.authorization_id AND a.material_sha256=s.material_sha256
        AND a.market=s.market AND a.offering=s.offering
      JOIN bb_rule_pack_production_reviewer_grants ag ON ag.id=a.authorizer_grant_id AND ag.user_id=a.authorized_by_user_id
      WHERE s.id=ANY($2::text[]) AND s.pack_id=$3 AND s.pack_version='1' AND s.pack_hash=$4
        AND s.market='sse' AND s.offering='private' AND s.sample_case_id=c->>'case_id' AND s.polarity=c->>'polarity'
        AND c->>'result'='passed' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements($1::jsonb) cases
          WHERE cases->>'case_id'=c->>'case_id'
        )
        AND s.reviewer_user_id=c->>'reviewed_by' AND g.role IN ('rule_pack_industry_reviewer','rule_pack_technical_reviewer')
        AND g.market='sse' AND g.offering='private' AND g.revoked_at IS NULL AND a.revoked_at IS NULL
        AND a.authorization_scope='rule_pack_validation' AND ag.role='rule_pack_operator'
        AND ag.market='sse' AND ag.offering='private' AND ag.revoked_at IS NULL
        AND s.expected_outcome=(SELECT example->>'expected_outcome' FROM jsonb_array_elements($5::jsonb) r
          CROSS JOIN LATERAL jsonb_array_elements(CASE c->>'polarity'
            WHEN 'positive' THEN r->'positive_examples' WHEN 'negative' THEN r->'negative_examples'
            WHEN 'boundary' THEN r->'boundary_examples' ELSE '[]'::jsonb END) example
          WHERE example->>'evidence_ref'=c->>'evidence_ref' LIMIT 1)
    ) AS matches FROM jsonb_array_elements($1::jsonb) c`,
    [json(pack.sample_suite.cases), samples.map(sample => sample.sample_evidence_id), id, packHash, json(pack.rules)]);
    assert.ok(sampleGuardDiagnostic.rows.every(row => row.matches), JSON.stringify(sampleGuardDiagnostic.rows));

    const frozen = await send('POST', '/api/v1/rule-pack-reviews/manifests', { request_id: `freeze-${suffix}`, content });
    assert.equal(frozen.statusCode, 200, frozen.body);
    const manifest = frozen.json();

    activeUser = industry;
    const industryResponse = await send('POST', `/api/v1/rule-pack-reviews/manifests/${id}/versions/1/attestations`, {
      request_id: `industry-${suffix}`, manifest_content_hash: manifest.content_sha256, attestation_kind: 'industry',
      decision: 'approve', reason: 'Synthetic test approval only.', evidence: makeIndustryEvidence(),
    });
    assert.equal(industryResponse.statusCode, 200, industryResponse.body);
    activeUser = technical;
    const technicalResponse = await send('POST', `/api/v1/rule-pack-reviews/manifests/${id}/versions/1/attestations`, {
      request_id: `technical-${suffix}`, manifest_content_hash: manifest.content_sha256, attestation_kind: 'technical',
      decision: 'approve', reason: 'Synthetic test approval only.', evidence: makeTechnicalEvidence(),
    });
    assert.equal(technicalResponse.statusCode, 200, technicalResponse.body);

    activeUser = operator;
    const releaseBody = { request_id: `release-${suffix}`, manifest_id: id, manifest_version: 1,
      manifest_content_hash: manifest.content_sha256, reason: 'Synthetic PG16 route test only.' };
    const released = await send('POST', '/api/v1/rule-pack-releases', releaseBody);
    assert.equal(released.statusCode, 200, released.body);
    assert.equal(released.json().manifest_content_sha256, manifest.content_sha256);
    assert.equal(released.json().operator_user_id, operator);
    assert.equal(released.json().industry_attestation_event_id, industryResponse.json().attestation_event_id);
    assert.equal(released.json().technical_attestation_event_id, technicalResponse.json().attestation_event_id);
    const replayed = await send('POST', '/api/v1/rule-pack-releases', releaseBody);
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.equal(replayed.json().id, released.json().id, 'same request key/hash replays the exact event');
    const outbox = await pool.query(`SELECT owner_user_id,aggregate_type,event_type,payload FROM bb_outbox WHERE id=$1`,
      [`rule-pack-prod-${released.json().id}`]);
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0].owner_user_id, operator);
    assert.equal(outbox.rows[0].aggregate_type, 'rule_pack_release');
    assert.equal(outbox.rows[0].payload.manifest_content_sha256, manifest.content_sha256);
    const audit = await pool.query(`SELECT actor_user_id,action FROM bb_rule_pack_production_release_audit WHERE event_id=$1`, [released.json().id]);
    assert.deepEqual(audit.rows, [{ actor_user_id: operator, action: 'production_release' }]);

    const withdrawn = await send('POST', `/api/v1/rule-pack-releases/${id}/withdrawals`, {
      request_id: `withdraw-${suffix}`, target_event_id: released.json().id, reason: 'Synthetic withdrawal route test only.',
    });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(withdrawn.json().action, 'production_withdrawal');
    assert.equal(withdrawn.json().target_event_id, released.json().id);
    assert.equal(withdrawn.json().manifest_content_sha256, manifest.content_sha256);

    const rolledBack = await send('POST', `/api/v1/rule-pack-releases/${id}/rollbacks`, {
      request_id: `rollback-${suffix}`, target_event_id: released.json().id, reason: 'Synthetic rollback route test only.',
    });
    assert.equal(rolledBack.statusCode, 200, rolledBack.body);
    assert.equal(rolledBack.json().action, 'production_rollback');
    assert.equal(rolledBack.json().target_event_id, released.json().id);
    assert.equal(rolledBack.json().manifest_content_sha256, manifest.content_sha256);
    assert.equal(rolledBack.json().industry_attestation_event_id, industryResponse.json().attestation_event_id);
    assert.equal(rolledBack.json().technical_attestation_event_id, technicalResponse.json().attestation_event_id);
    const eventRows = await pool.query(`SELECT action,target_event_id,operator_user_id FROM bb_rule_pack_production_release_events
      WHERE pack_id=$1 ORDER BY sequence`, [id]);
    assert.deepEqual(eventRows.rows.map(row => [row.action,row.target_event_id,row.operator_user_id]), [
      ['production_release', null, operator], ['production_withdrawal', released.json().id, operator],
      ['production_rollback', released.json().id, operator],
    ]);
    const actionAudit = await pool.query(`SELECT actor_user_id,action FROM bb_rule_pack_production_release_audit
      WHERE event_id=ANY($1::text[]) ORDER BY action`, [[withdrawn.json().id, rolledBack.json().id]]);
    assert.deepEqual(actionAudit.rows, [
      { actor_user_id: operator, action: 'production_rollback' },
      { actor_user_id: operator, action: 'production_withdrawal' },
    ]);
    for (const event of [withdrawn.json(), rolledBack.json()]) {
      const actionOutbox = await pool.query('SELECT owner_user_id,aggregate_type FROM bb_outbox WHERE id=$1', [`rule-pack-prod-${event.id}`]);
      assert.deepEqual(actionOutbox.rows, [{ owner_user_id: operator, aggregate_type: 'rule_pack_release' }]);
    }
  } finally { await app.close(); await pool.end(); }
});
