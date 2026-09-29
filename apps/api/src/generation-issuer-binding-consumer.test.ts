import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationIssuerBindingResponse } from '@bondbuddy/contracts';
import {
  consumeGenerationIssuerBinding,
  type GenerationIssuerBindingLoader,
  type GenerationIssuerBindingSeam,
} from './generation-issuer-binding-consumer.js';

const owner = 'owner-synthetic', project = 'project-synthetic';
const scope = { ownerUserId: owner, projectId: project };
const ref = { binding_id: 'binding-synthetic', version: 1, content_sha256: 'a'.repeat(64) };
const expectedInput = { owner_user_id: owner, project_id: project, input_revision: 3, input_hash: 'b'.repeat(64) };
const pool = { query: async () => ({ rows: [] as Record<string, unknown>[] }) };

function binding(overrides: Partial<GenerationIssuerBindingResponse> = {}): GenerationIssuerBindingResponse {
  return {
    schema_version: 'generation-issuer-binding-v1', binding_id: ref.binding_id, version: ref.version, content_sha256: ref.content_sha256,
    owner_user_id: owner, project_id: project, input_revision: expectedInput.input_revision, input_hash: expectedInput.input_hash,
    selected_materials: [{ material_id: 'material-audit', material_version: 1, role: 'audit', material_sha256: 'c'.repeat(64),
      parse_snapshot_id: 'snapshot-audit', parse_response_sha256: 'd'.repeat(64), parse_coverage: 'complete', parse_warning_codes: [],
      identity_coverage: 'complete', identity_uncertainties: [] }],
    material_decisions: [], disputes: [], status: 'approved', issuer_entity_id: 'entity:11111111-1111-4111-8111-111111111111',
    review_events: [], created_at: '2026-09-25T00:00:00Z', ...overrides,
  };
}

function seam(overrides: Partial<GenerationIssuerBindingSeam> = {}): GenerationIssuerBindingSeam {
  return { provider: { provide: async () => ref }, load: (async () => binding()) as GenerationIssuerBindingLoader, ...overrides };
}

test('an approved binding for the exact locked input is the only usable generation subject', async () => {
  const consumed = await consumeGenerationIssuerBinding(pool, scope, seam(), expectedInput);
  assert.equal(consumed.status, 'approved');
  if (consumed.status !== 'approved') return;
  assert.equal(consumed.issuer_entity_id, binding().issuer_entity_id);
  assert.deepEqual(consumed.ref, ref);
});

test('missing, rejected, stale, conflict, cross-account and malformed bindings all fail closed', async () => {
  const rejected: Array<[string, GenerationIssuerBindingSeam, typeof expectedInput]> = [
    ['provider returns no ref', seam({ provider: { provide: async () => null } }), expectedInput],
    ['loader returns null (unreviewed/withdrawn/stale)', seam({ load: async () => null }), expectedInput],
    ['loader rejects a different content hash', seam({ load: async () => binding({ content_sha256: 'f'.repeat(64) }) }), expectedInput],
    ['binding targets another input revision', seam({ load: async () => binding({ input_revision: 99 }) }), expectedInput],
    ['binding belongs to another owner', seam({ load: async () => binding({ owner_user_id: 'other-owner' }) }), expectedInput],
    ['binding is not approved', seam({ load: async () => binding({ status: 'withdrawn' }) }), expectedInput],
    ['binding has no issuer entity', seam({ load: async () => binding({ issuer_entity_id: null }) }), expectedInput],
    ['identity coverage is incomplete', seam({ load: async () => binding({
      selected_materials: [{ ...binding().selected_materials[0]!, identity_coverage: 'incomplete' }] }) }), expectedInput],
    ['a selected material is not an issuer role', seam({ load: async () => binding({
      selected_materials: [{ ...binding().selected_materials[0]!, role: 'historical' as never }] }) }), expectedInput],
    ['provider throws', seam({ provider: { provide: async () => { throw new Error('synthetic'); } } }), expectedInput],
    ['loader throws', seam({ load: async () => { throw new Error('synthetic'); } }), expectedInput],
    ['expected input belongs to another account', seam(), { ...expectedInput, owner_user_id: 'other-owner' }],
    ['expected input hash is malformed', seam(), { ...expectedInput, input_hash: 'not-a-hash' }],
  ];
  for (const [description, injected, input] of rejected) {
    const consumed = await consumeGenerationIssuerBinding(pool, scope, injected, input);
    assert.deepEqual(consumed, { status: 'not_bound', reason: 'issuer_identity_not_bound' }, description);
  }
});

test('a provider failure is never treated as an implicit binding', async () => {
  let providerCalls = 0;
  const consumed = await consumeGenerationIssuerBinding(pool, scope, seam({
    provider: { provide: async () => { providerCalls++; return null; } },
  }), { ...expectedInput, project_id: 'other-project' });
  assert.equal(consumed.status, 'not_bound');
  assert.equal(providerCalls, 0, 'a cross-project expected input is rejected before any trusted read');
});
