import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { productionReviewContentHash } from '@bondbuddy/rule-pack-registry';

const databaseUrl = await isolatedTestDatabase('PRODUCTION_REVIEW_LEDGER_TEST_DATABASE_URL');
const origin = 'http://bondbuddy.test';
const manifestFixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/examples/production-review-manifest.json', import.meta.url), 'utf8')) as any;
const attestationFixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/examples/production-review-attestation.json', import.meta.url), 'utf8')) as any;
assert.equal(manifestFixture.synthetic, true);
assert.equal(attestationFixture.synthetic, true);
const fixtureContent = structuredClone(manifestFixture.cases[0].value.content);
const industryFixture = structuredClone(attestationFixture.cases.find((item: any) => item.name === 'production-attestation-industry-self-submission-valid-synthetic').value);
const technicalFixture = structuredClone(attestationFixture.cases.find((item: any) => item.name === 'production-attestation-technical-self-submission-valid-synthetic').value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)!, 'utf8').digest('hex');

test('synthetic PostgreSQL ledger enforces scoped grants, immutable hash pins and self-attested append-only events', {
  skip: !databaseUrl && 'set PRODUCTION_REVIEW_LEDGER_TEST_DATABASE_URL to an isolated PostgreSQL 16 database migrated through 0071',
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl! });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const user = (role: string) => `pr-${role}-${suffix}`;
  const operator = user('operator'), industry = user('industry'), technical = user('technical');
  const otherIndustry = user('industry-b'), narrow = user('narrow'), grantor = user('grantor');
  const grants = { operator: `pr-og-${suffix}`, industry: `pr-ig-${suffix}`, technical: `pr-tg-${suffix}`,
    industryB: `pr-igb-${suffix}`, dual: `pr-dg-${suffix}`, narrow: `pr-ng-${suffix}` };
  let activeUser = operator;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: activeUser, csrfVerified: true }) });
  const send = async (method: string, url: string, payload?: unknown): Promise<any> => await app.inject({ method: method as any,
    url, headers: { origin }, ...(payload === undefined ? {} : { payload: payload as any }) });
  const scopedGrant = async (id: string, grantee: string, role: string, allowedInstruments = fixtureContent.applicability_scope.instruments) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO bb_rule_pack_production_reviewer_grants
        (id,user_id,role,market,offering,granted_by,reason_code) VALUES($1,$2,$3,'nafmii','mtn',$4,'synthetic_test')`, [id, grantee, role, grantor]);
      const scope = fixtureContent.applicability_scope;
      const values = { instruments: allowedInstruments, document_stages: scope.document_stages, issuer_scopes: scope.issuer_scopes,
        investor_scopes: scope.investor_scopes, industry_codes: scope.industry_codes, special_feature_scope: scope.special_feature_scope };
      await client.query(`INSERT INTO bb_rule_pack_production_grant_scopes
        (grant_id,instruments,document_stages,issuer_scopes,investor_scopes,industry_codes,special_feature_scope,scope_hash)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8)`, [id, values.instruments, values.document_stages,
        JSON.stringify(values.issuer_scopes), JSON.stringify(values.investor_scopes), JSON.stringify(values.industry_codes),
        JSON.stringify(values.special_feature_scope), hash(values)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  const content = () => structuredClone(fixtureContent);
  const freeze = async (requestId: string, draft: any = content()) => send('POST', '/api/v1/rule-pack-reviews/manifests', { request_id: requestId, content: draft });
  const attestBody = (target: any, fixture: any, kind: 'industry'|'technical', requestId: string) => ({ request_id: requestId,
    manifest_content_hash: target.content_sha256, attestation_kind: kind, decision: 'request_more_evidence',
    reason: 'Synthetic fixture decision only.', evidence: fixture.evidence });
  try {
    const phoneSuffix = [...suffix].map(character => Number.parseInt(character, 16) % 10).join('');
    for (const [i, id] of [operator, industry, technical, otherIndustry, narrow, grantor].entries()) {
      const phone = `+1${phoneSuffix}${i}`;
      await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)', [id, phone]);
    }
    await scopedGrant(grants.operator, operator, 'rule_pack_operator');
    await scopedGrant(grants.industry, industry, 'rule_pack_industry_reviewer');
    await scopedGrant(grants.technical, technical, 'rule_pack_technical_reviewer');
    await scopedGrant(grants.industryB, otherIndustry, 'rule_pack_industry_reviewer');
    await scopedGrant(grants.dual, industry, 'rule_pack_technical_reviewer');
    await scopedGrant(grants.narrow, narrow, 'rule_pack_industry_reviewer', ['scp']);

    const frozen = await freeze(`freeze-${suffix}`);
    assert.equal(frozen.statusCode, 200, frozen.body);
    const manifest = frozen.json();
    assert.equal(manifest.manifest_id, fixtureContent.rule_pack.id);
    assert.equal(manifest.manifest_version, 1);
    assert.equal((await freeze(`freeze-${suffix}`)).json().content_sha256, manifest.content_sha256, 'same request/hash replays');
    assert.equal((await freeze(`freeze-${suffix}`, { ...content(), chapter_template: { ...content().chapter_template, sha256: 'a'.repeat(64) } })).statusCode, 409,
      'same request id cannot bind changed content');
    const drifted = await send('POST', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/${manifest.manifest_version}/attestations`,
      { ...attestBody(manifest, industryFixture, 'industry', `drift-${suffix}`), manifest_content_hash: '0'.repeat(64) });
    assert.equal(drifted.statusCode, 409, 'stale manifest hash is a conflict');

    activeUser = narrow;
    assert.equal((await send('GET', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1`)).statusCode, 403,
      'a grant with a narrower instrument set cannot read the manifest');
    activeUser = otherIndustry;
    assert.equal((await send('POST', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1/attestations`,
      attestBody(manifest, technicalFixture, 'technical', `wrong-role-${suffix}`))).statusCode, 403,
    'attestation kind must match an active reviewer-role grant');

    activeUser = industry;
    const read = await send('GET', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1`);
    assert.equal(read.statusCode, 200, read.body);
    const industryRequest = attestBody(manifest, industryFixture, 'industry', `industry-${suffix}`);
    const submitted = await send('POST', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1/attestations`, industryRequest);
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal(submitted.json().reviewer_user_id, industry, 'reviewer identity comes from server session');
    assert.equal((await send('POST', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1/attestations`, industryRequest)).json().attestation_event_id,
      submitted.json().attestation_event_id, 'request_id plus server hash is idempotent');
    const spoof = { ...attestBody(manifest, technicalFixture, 'technical', `spoof-${suffix}`) };
    assert.equal((await send('POST', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1/attestations`, spoof)).statusCode, 409,
      'one session user cannot attest both roles, even with two grants');

    activeUser = technical;
    const technicalRequest = attestBody(manifest, technicalFixture, 'technical', `technical-${suffix}`);
    const technicalEvent = await send('POST', `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1/attestations`, technicalRequest);
    assert.equal(technicalEvent.statusCode, 200, technicalEvent.body);
    const withdrawalUrl = `/api/v1/rule-pack-reviews/manifests/${manifest.manifest_id}/versions/1/attestations/${technicalEvent.json().attestation_event_id}/withdrawal`;
    activeUser = industry;
    assert.equal((await send('POST', withdrawalUrl, { request_id: `wrong-user-${suffix}`, reason: 'Synthetic wrong actor.' })).statusCode, 404,
      'only the attesting session user can withdraw');
    activeUser = technical;
    const ownWithdrawal = await send('POST', withdrawalUrl, { request_id: `withdraw-${suffix}`, reason: 'Synthetic withdrawal.' });
    assert.equal(ownWithdrawal.statusCode, 200, ownWithdrawal.body);
    assert.equal((await send('POST', withdrawalUrl, { request_id: `withdraw-${suffix}`, reason: 'Synthetic withdrawal.' })).json().withdrawal_event_id,
      ownWithdrawal.json().withdrawal_event_id, 'withdrawal request replay is idempotent');

    // The migration's deferred guard refuses any new grant that omits the scope row.
    const legacyUser = user('legacy'), legacyGrant = `pr-lg-${suffix}`;
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)', [legacyUser, `+2${phoneSuffix}99`]);
    const legacyClient = await pool.connect();
    try {
      await legacyClient.query('BEGIN');
      await legacyClient.query(`INSERT INTO bb_rule_pack_production_reviewer_grants
        (id,user_id,role,market,offering,granted_by,reason_code) VALUES($1,$2,'rule_pack_industry_reviewer','nafmii','mtn',$3,'synthetic_legacy')`, [legacyGrant, legacyUser, grantor]);
      await assert.rejects(legacyClient.query('COMMIT'), /requires an immutable applicability scope/,
        'a grant without its scope cannot commit');
      await legacyClient.query('ROLLBACK').catch(() => undefined);
    } finally { legacyClient.release(); }

    // Two properly scoped industry reviewers race for one active role slot on the next manifest version.
    activeUser = operator;
    const nextVersion = await freeze(`freeze-next-${suffix}`);
    assert.equal(nextVersion.statusCode, 200, nextVersion.body);
    const target = nextVersion.json();
    const appFor = (reviewer: string) => createServer({ pool, allowedOrigin: origin,
      principal: async () => ({ userId: reviewer, csrfVerified: true }) });
    const appA = appFor(industry), appB = appFor(otherIndustry);
    const raceUrl = `/api/v1/rule-pack-reviews/manifests/${target.manifest_id}/versions/${target.manifest_version}/attestations`;
    const raceRequest = attestBody(target, industryFixture, 'industry', `race-${suffix}`);
    const race: any[] = await Promise.all([appA, appB].map(async candidate => await candidate.inject({ method: 'POST', url: raceUrl,
      headers: { origin }, payload: raceRequest as any }) as any));
    await Promise.all([appA.close(), appB.close()]);
    assert.deepEqual(race.map(row => row.statusCode).sort(), [200, 409], 'pack advisory lock serializes concurrent role submissions');
    activeUser = technical;
    const revocationRequest = attestBody(target, technicalFixture, 'technical', `before-revoke-${suffix}`);
    const revocationEvent = await send('POST', raceUrl, revocationRequest);
    assert.equal(revocationEvent.statusCode, 200, revocationEvent.body);
    await pool.query('UPDATE bb_rule_pack_production_reviewer_grants SET revoked_at=now() WHERE id=$1', [grants.technical]);
    const revokedWithdrawal = await send('POST', `${raceUrl}/${revocationEvent.json().attestation_event_id}/withdrawal`,
      { request_id: `after-revoke-${suffix}`, reason: 'Synthetic revoked reviewer.' });
    assert.equal(revokedWithdrawal.statusCode, 200, 'the original active account may withdraw its own event after grant revocation');
    activeUser = operator;
    const afterRevocation = await freeze(`freeze-after-revoke-${suffix}`);
    assert.equal(afterRevocation.statusCode, 200, afterRevocation.body);
    activeUser = technical;
    assert.equal((await send('POST', `/api/v1/rule-pack-reviews/manifests/${afterRevocation.json().manifest_id}/versions/${afterRevocation.json().manifest_version}/attestations`,
      attestBody(afterRevocation.json(), technicalFixture, 'technical', `rejected-after-revoke-${suffix}`))).statusCode, 403,
    'revoked grant cannot submit a new attestation');
    const auditCount = await pool.query("SELECT count(*)::int AS n FROM bb_outbox WHERE aggregate_type='rule_pack_manifest' AND aggregate_id=$1", [manifest.manifest_id]);
    assert.ok(auditCount.rows[0].n >= 5, 'freeze, signatures and withdrawal each append outbox events');
  } finally { await app.close(); await pool.end(); }
});
