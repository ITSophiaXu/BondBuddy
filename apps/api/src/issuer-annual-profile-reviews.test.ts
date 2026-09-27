import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from './server.js';

test('annual issuer-profile review routes require a trusted session and CSRF on decisions', async () => {
  let principal: { userId: string; csrfVerified: boolean } | null = null;
  const app = createServer({ allowedOrigin: 'http://bondbuddy.test', principal: async () => principal });
  try {
    const list = await app.inject({ method: 'GET', url: '/api/v1/reviewer/projects/synthetic-project/issuer-business-profiles',
      headers: { origin: 'http://bondbuddy.test' } });
    assert.equal(list.statusCode, 401);

    principal = { userId: 'synthetic-reviewer', csrfVerified: false };
    const decision = await app.inject({ method: 'POST', url: '/api/v1/projects/synthetic-project/issuer-business-profiles/synthetic-profile/review',
      headers: { origin: 'http://bondbuddy.test' }, payload: { request_id: 'synthetic-review', action: 'approve', reason: 'synthetic',
        reviewer_attestation: 'manual_source_evidence_review', profile_version: 1, profile_sha256: 'a'.repeat(64), input_revision: 1,
        input_hash: 'b'.repeat(64), source_material_sha256: 'c'.repeat(64), parse_snapshot_sha256: 'd'.repeat(64) } });
    assert.equal(decision.statusCode, 403);
    assert.equal(decision.json().code, 'CSRF_DENIED');
  } finally { await app.close(); }
});
