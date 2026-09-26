import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { resolveUserReferencePin, type UserReferenceChoice } from './user-reference-lock.js';

const sha = 'a'.repeat(64);
const scope = { owner: 'synthetic-owner', projectId: 'synthetic-project', revision: 1, market: 'sse', offering: 'private' };
const choice: UserReferenceChoice = {
  material_id: 'synthetic-reference', material_version: 1, material_sha256: sha,
  parse_snapshot_id: 'synthetic-parse-snapshot', target_product: 'synthetic-product-requested-by-client',
  target_document_stage: 'registration',
};
const material = { material_id: choice.material_id, material_version: 1, role: 'reference', sha256: sha };
const outline = [{ order: 1, heading: 'Synthetic chapter' }];

function clientFor(snapshotStatus: 'parsed' | 'needs_confirmation', calls: string[], queries: string[] = []): PoolClient {
  const reviewed = {
    id: 'synthetic-review', revoked_at: null, material_sha256: sha,
    target_market: scope.market, target_offering: scope.offering,
    target_product: choice.target_product, target_document_stage: choice.target_document_stage,
    status: 'accepted', authorization_status: 'accepted', readability_status: 'accepted',
    applicability_status: 'accepted', fact_isolation_check_version: 'synthetic-check-v1',
    reviewer_user_id: 'synthetic-reviewer', reviewer_grant_id: 'synthetic-grant', outline,
  };
  return {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM bb_parse_snapshots')) {
        calls.push('snapshot');
        return { rows: [{ id: choice.parse_snapshot_id, content_sha256: sha, response_status: snapshotStatus,
          response_schema_version: 'document-parse-response-v1', record_count: 1 }] };
      }
      if (sql.includes('FROM bb_user_reference_reviews')) {
        calls.push('review');
        return { rows: [reviewed] };
      }
      throw new Error(`Unexpected synthetic query: ${sql}`);
    },
  } as unknown as PoolClient;
}

test('diagnostic: pin resolver accepts a self-consistent requested product/stage without a trusted target to compare', async () => {
  // This target is deliberately held by the test harness and is not an input to the resolver.
  // It demonstrates the missing comparison boundary only; it is not evidence of a user-controlled API exploit.
  const trustedTarget = { product: 'different-synthetic-product', documentStage: 'issuance' };
  assert.notDeepEqual(
    { product: choice.target_product, documentStage: choice.target_document_stage },
    trustedTarget,
  );

  const calls: string[] = [];
  const resolved = await resolveUserReferencePin(clientFor('parsed', calls), scope, choice, [material]);

  assert.equal(resolved.pin.status, 'accepted');
  assert.equal(resolved.pin.target_product, choice.target_product);
  assert.equal(resolved.pin.target_document_stage, choice.target_document_stage);
  assert.deepEqual(calls, ['snapshot', 'review']);
});

test('diagnostic: DOCX needs_confirmation with known warnings is blocked before an otherwise accepted review is read', async () => {
  // Synthetic authorized-style DOCX metadata: this case has usable records and known warnings,
  // but the locked user-reference path accepts only a parse snapshot whose status is `parsed`.
  // The warning is known to the fixture; the pin resolver query does not load warning metadata.
  const parseFixture = { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    status: 'needs_confirmation' as const, warningCodes: ['DOCX_AUXILIARY_PARTS'], recordCount: 1 };
  assert.ok(parseFixture.warningCodes.length > 0);
  const calls: string[] = [];
  const queries: string[] = [];

  await assert.rejects(
    resolveUserReferencePin(clientFor(parseFixture.status, calls, queries), scope, choice, [material]),
    (error: unknown) => error instanceof Error && error.message === 'Selected reference has no matching parsed snapshot',
  );

  // clientFor contains a fully accepted synthetic review row, but resolution exits at the parse gate.
  assert.deepEqual(calls, ['snapshot']);
  assert.match(parseFixture.mediaType, /wordprocessingml\.document/);
  assert.match(queries[0] ?? '', /response_status/);
  assert.doesNotMatch(queries[0] ?? '', /response_meta|warnings/);
});
