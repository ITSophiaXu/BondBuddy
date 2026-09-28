import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';

const optedIn = process.env.BB_RUN_RULE_SOURCE_DATE_JSON_PG_TESTS === '1';
const databaseUrl = optedIn ? await isolatedTestDatabase('RULE_SOURCE_DATE_JSON_TEST_DATABASE_URL') : undefined;

test('PostgreSQL 16 source applicability and method-window JSON guards reject incomplete evidence', {
  skip: !optedIn
    ? 'set BB_RUN_RULE_SOURCE_DATE_JSON_PG_TESTS=1 to run the source-date JSON guard regression'
    : !databaseUrl
      ? 'set RULE_SOURCE_DATE_JSON_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable PostgreSQL 16 database migrated through 0064'
      : false,
}, async () => {
  assert.ok(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const admin = `date-json-admin-${suffix}`;
  const reviewer = `date-json-reviewer-${suffix}`;
  const grant = `date-json-grant-${suffix}`;
  const basisHash = 'a'.repeat(64);
  const sourceHash = 'b'.repeat(64);
  const evidenceHash = 'c'.repeat(64);
  const validBasis = {
    basis_id: 'synthetic-basis',
    basis_version: 1,
    basis_sha256: basisHash,
    source_document_sha256: sourceHash,
    applicability_scope: {},
    time_basis: 'source explicit interval',
    locator: {},
  };
  const validWindow = {
    enabled_from: '2026-01-01',
    enabled_until: null,
    approval_evidence_id: 'synthetic-approval',
    approval_evidence_sha256: evidenceHash,
  };

  async function insertSource(id: string, applicabilityBasis: unknown, approvedMethodWindow: unknown) {
    await pool.query(`INSERT INTO bb_rule_pack_production_source_checks
      (id,pack_id,pack_version,pack_hash,source_id,authority,official_url,source_version,market,offering,
       clause_locator,exact_quote,checked_at,effective_from,legal_effective_date_basis,verifier_user_id,verifier_grant_id,
       applicability_basis,approved_method_window)
      VALUES($1,'synthetic-date-pack','1',$2,$3,'Synthetic authority','https://example.invalid/source','synthetic-v1',
       'sse','public_all','synthetic locator','Synthetic only',now(),NULL,'unknown',$4,$5,$6::jsonb,$7::jsonb)`,
    [id, 'd'.repeat(64), `source-${id}`, reviewer, grant,
      applicabilityBasis === null ? null : JSON.stringify(applicabilityBasis),
      approvedMethodWindow === null ? null : JSON.stringify(approvedMethodWindow)]);
  }

  try {
    const version = await pool.query<{ server_version_num: string }>("SELECT current_setting('server_version_num') AS server_version_num");
    assert.ok(Number(version.rows[0]!.server_version_num) >= 160000, 'regression requires PostgreSQL 16 or newer');
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)',
      [admin, `datejsonadmin${suffix.slice(0, 12)}`, reviewer, `datejsonreviewer${suffix.slice(0, 12)}`]);
    await pool.query(`INSERT INTO bb_rule_pack_production_reviewer_grants
      (id,user_id,role,market,offering,granted_by,reason_code)
      VALUES($1,$2,'rule_pack_industry_reviewer','sse','public_all',$3,'synthetic_test')`, [grant, reviewer, admin]);

    await insertSource(`pending-${suffix}`, null, null);
    await insertSource(`valid-${suffix}`, validBasis, validWindow);

    const basisMissingKeys = [
      'basis_id', 'basis_version', 'basis_sha256', 'source_document_sha256',
      'applicability_scope', 'time_basis', 'locator',
    ];
    for (const key of basisMissingKeys) {
      const incomplete = { ...validBasis } as Record<string, unknown>;
      delete incomplete[key];
      await assert.rejects(insertSource(`basis-missing-${key}-${suffix}`, incomplete, null),
        error => (error as { code?: string }).code === '23514', `missing applicability_basis.${key} must fail`);
    }
    for (const key of basisMissingKeys) {
      const incomplete = { ...validBasis, [key]: null };
      await assert.rejects(insertSource(`basis-null-${key}-${suffix}`, incomplete, null),
        error => (error as { code?: string }).code === '23514', `JSON null applicability_basis.${key} must fail`);
    }

    const basisWrongTypes: Array<[string, unknown]> = [
      ['basis_id', 1], ['basis_version', '1'], ['basis_sha256', 1], ['source_document_sha256', 1],
      ['applicability_scope', []], ['time_basis', 1], ['locator', []],
    ];
    for (const [key, value] of basisWrongTypes) {
      await assert.rejects(insertSource(`basis-type-${key}-${suffix}`, { ...validBasis, [key]: value }, null),
        error => (error as { code?: string }).code === '23514', `wrong applicability_basis.${key} type must fail`);
    }
    await assert.rejects(insertSource(`basis-version-range-${suffix}`, { ...validBasis, basis_version: 2147483648 }, null),
      error => (error as { code?: string }).code === '23514', 'basis_version must fit the #367 positive int32 schema');
    await assert.rejects(insertSource(`basis-blank-id-${suffix}`, { ...validBasis, basis_id: ' \t ' }, null),
      error => (error as { code?: string }).code === '23514', 'blank basis_id must fail');

    const methodMissingKeys = ['enabled_from', 'enabled_until', 'approval_evidence_id', 'approval_evidence_sha256'];
    for (const key of methodMissingKeys) {
      const incomplete = { ...validWindow } as Record<string, unknown>;
      delete incomplete[key];
      await assert.rejects(insertSource(`window-missing-${key}-${suffix}`, null, incomplete),
        error => (error as { code?: string }).code === '23514', `missing approved_method_window.${key} must fail`);
    }
    for (const key of ['enabled_from', 'approval_evidence_id', 'approval_evidence_sha256']) {
      await assert.rejects(insertSource(`window-null-${key}-${suffix}`, null, { ...validWindow, [key]: null }),
        error => (error as { code?: string }).code === '23514', `JSON null approved_method_window.${key} must fail`);
    }
    const methodWrongTypes: Array<[string, unknown]> = [
      ['enabled_from', 1], ['enabled_until', 1], ['approval_evidence_id', 1], ['approval_evidence_sha256', 1],
    ];
    for (const [key, value] of methodWrongTypes) {
      await assert.rejects(insertSource(`window-type-${key}-${suffix}`, null, { ...validWindow, [key]: value }),
        error => (error as { code?: string }).code === '23514', `wrong approved_method_window.${key} type must fail`);
    }
    await assert.rejects(insertSource(`window-blank-id-${suffix}`, null, { ...validWindow, approval_evidence_id: '  ' }),
      error => (error as { code?: string }).code === '23514', 'blank approval_evidence_id must fail');

    const accepted = await pool.query<{ applicability_basis: unknown; approved_method_window: unknown; effective_from: string | null }>(
      `SELECT applicability_basis,approved_method_window,effective_from FROM bb_rule_pack_production_source_checks
       WHERE id=ANY($1::text[])`, [[`pending-${suffix}`, `valid-${suffix}`]]);
    assert.equal(accepted.rowCount, 2);
    assert.equal(accepted.rows.find(row => row.effective_from === null)?.applicability_basis, null,
      'whole SQL NULL objects remain valid pending evidence');
    assert.deepEqual(accepted.rows.find(row => row.applicability_basis !== null)?.applicability_basis, validBasis);
    assert.deepEqual(accepted.rows.find(row => row.approved_method_window !== null)?.approved_method_window, validWindow,
      'a present enabled_until key may be JSON null to represent an open-ended window');
  } finally {
    await pool.end();
  }
});
