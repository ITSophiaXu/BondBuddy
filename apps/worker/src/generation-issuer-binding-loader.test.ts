import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { GenerationIssuerBindingResponse } from '@bondbuddy/contracts';
import {
  loadPinnedApprovedGenerationIssuerBinding,
  lockedIssuerMaterialsMatch,
  pinnedGenerationIssuerBindingRef,
  type VerifyPinnedBinding,
} from './generation-issuer-binding-loader.js';
import type { NoHistoryRunScope } from './no-history-model-stage.js';

const entityId = 'entity:11111111-1111-4111-8111-111111111111';
const material = {
  material_id: 'material-audit',
  material_version: 1,
  role: 'audit',
  sha256: 'b'.repeat(64),
};
const contentSha256 = 'c'.repeat(64);
const bindingRef = { binding_id: 'binding-synthetic', version: 2, content_sha256: contentSha256 };
const baseManifest = {
  kind: 'generation',
  materials: [material],
  generation_issuer_binding_ref: bindingRef,
  generation_issuer_entity_id: entityId,
};
const inputHash = inputManifestHash(baseManifest);
/** The binding is created against an earlier input; the run input that pins the ref is a later one. */
const bindingInputRevision = 1,
  bindingInputHash = 'e'.repeat(64);
const scope: NoHistoryRunScope = {
  ownerUserId: 'owner-synthetic',
  projectId: 'project-synthetic',
  runId: 'run-synthetic',
  inputRevision: 4,
  inputHash,
};

function bindingResponse(
  overrides: Partial<GenerationIssuerBindingResponse> = {},
): GenerationIssuerBindingResponse {
  return {
    schema_version: 'generation-issuer-binding-v1',
    binding_id: bindingRef.binding_id,
    version: bindingRef.version,
    content_sha256: contentSha256,
    owner_user_id: scope.ownerUserId,
    project_id: scope.projectId,
    input_revision: bindingInputRevision,
    input_hash: bindingInputHash,
    selected_materials: [
      {
        material_id: material.material_id,
        material_version: material.material_version,
        role: 'audit',
        material_sha256: material.sha256,
        parse_snapshot_id: 'snapshot-synthetic',
        parse_response_sha256: 'd'.repeat(64),
        parse_coverage: 'complete',
        parse_warning_codes: [],
        identity_coverage: 'complete',
        identity_uncertainties: [],
      },
    ],
    material_decisions: [],
    disputes: [],
    status: 'approved',
    issuer_entity_id: entityId,
    review_events: [
      {
        review_id: 'review-synthetic',
        action: 'approve',
        reason: 'synthetic approval',
        reviewer_user_id: 'reviewer-synthetic',
        reviewer_grant_id: 'grant-synthetic',
        authority: 'issuer_identity_reviewer',
        binding_version: bindingRef.version,
        binding_content_sha256: contentSha256,
        reviewed_at: '2026-09-25T00:00:00Z',
      },
    ],
    created_at: '2026-09-25T00:00:00Z',
    ...overrides,
  };
}

function fakePool(rows: Record<string, unknown>[]): Pick<Pool, 'query'> {
  return { query: async () => ({ rows }) } as unknown as Pick<Pool, 'query'>;
}

function load(
  manifest: unknown,
  options: {
    rows?: Record<string, unknown>[];
    inputHash?: string;
    verify?: VerifyPinnedBinding;
  } = {},
) {
  const rows = options.rows ?? [{ manifest, input_hash: inputManifestHash(manifest) }];
  return loadPinnedApprovedGenerationIssuerBinding(
    fakePool(rows),
    { ...scope, inputHash: options.inputHash ?? inputManifestHash(manifest) },
    options.verify,
  );
}

test('a manifest pin is accepted only with a canonical ref, positive version and verified entity', () => {
  assert.deepEqual(pinnedGenerationIssuerBindingRef(baseManifest), {
    ref: bindingRef,
    issuerEntityId: entityId,
  });
  const invalid: Array<[string, unknown]> = [
    ['missing ref', { ...baseManifest, generation_issuer_binding_ref: undefined }],
    ['null ref', { ...baseManifest, generation_issuer_binding_ref: null }],
    ['array ref', { ...baseManifest, generation_issuer_binding_ref: [bindingRef] }],
    [
      'free-form binding id',
      { ...baseManifest, generation_issuer_binding_ref: { ...bindingRef, binding_id: 'bad id' } },
    ],
    [
      'empty binding id',
      { ...baseManifest, generation_issuer_binding_ref: { ...bindingRef, binding_id: '' } },
    ],
    [
      'zero version',
      { ...baseManifest, generation_issuer_binding_ref: { ...bindingRef, version: 0 } },
    ],
    [
      'fractional version',
      { ...baseManifest, generation_issuer_binding_ref: { ...bindingRef, version: 1.5 } },
    ],
    [
      'string version',
      { ...baseManifest, generation_issuer_binding_ref: { ...bindingRef, version: '2' } },
    ],
    [
      'uppercase hash',
      {
        ...baseManifest,
        generation_issuer_binding_ref: {
          ...bindingRef,
          content_sha256: contentSha256.toUpperCase(),
        },
      },
    ],
    [
      'short hash',
      { ...baseManifest, generation_issuer_binding_ref: { ...bindingRef, content_sha256: 'abc' } },
    ],
    ['missing entity', { ...baseManifest, generation_issuer_entity_id: undefined }],
    [
      'malformed entity',
      { ...baseManifest, generation_issuer_entity_id: 'issuer-name-from-browser' },
    ],
    ['non-object manifest', 'generation'],
    ['null manifest', null],
  ];
  for (const [description, manifest] of invalid)
    assert.equal(pinnedGenerationIssuerBindingRef(manifest), null, description);
});

test('the locked issuer materials must equal the pinned binding selected materials exactly', () => {
  const selected = bindingResponse().selected_materials;
  assert.equal(lockedIssuerMaterialsMatch(baseManifest, selected), true);
  const withReference = {
    ...baseManifest,
    materials: [
      ...baseManifest.materials,
      {
        material_id: 'material-reference',
        material_version: 1,
        role: 'reference',
        sha256: 'e'.repeat(64),
      },
    ],
  };
  assert.equal(
    lockedIssuerMaterialsMatch(withReference, selected),
    true,
    'non-issuer roles are ignored',
  );
  const cases: Array<
    [string, unknown, readonly GenerationIssuerBindingResponse['selected_materials'][number][]]
  > = [
    [
      'extra issuer material',
      {
        ...baseManifest,
        materials: [...baseManifest.materials, { ...material, material_id: 'material-extra' }],
      },
      selected,
    ],
    ['missing issuer material', { ...baseManifest, materials: [] }, selected],
    [
      'swapped material hash',
      { ...baseManifest, materials: [{ ...material, sha256: 'f'.repeat(64) }] },
      selected,
    ],
    [
      'swapped material version',
      { ...baseManifest, materials: [{ ...material, material_version: 2 }] },
      selected,
    ],
    [
      'binding covers an extra pin',
      baseManifest,
      [...selected, { ...selected[0]!, material_id: 'material-extra' }],
    ],
    [
      'binding pin hash differs',
      baseManifest,
      [{ ...selected[0]!, material_sha256: 'f'.repeat(64) }],
    ],
    ['no issuer materials at all', { ...baseManifest, materials: [] }, []],
  ];
  for (const [description, manifest, pins] of cases)
    assert.equal(lockedIssuerMaterialsMatch(manifest, pins), false, description);
});

test('the locked manifest loader fails closed for a missing, malformed, stale or foreign pin', async () => {
  let verifyCalls = 0;
  const verify: VerifyPinnedBinding = async () => {
    verifyCalls++;
    return bindingResponse();
  };
  assert.equal(
    await load({ ...baseManifest, generation_issuer_binding_ref: undefined }, { verify }),
    null,
    'no pinned ref',
  );
  assert.equal(
    await load(
      {
        ...baseManifest,
        generation_issuer_binding_ref: {
          binding_id: 'bad id',
          version: 2,
          content_sha256: contentSha256,
        },
      },
      { verify },
    ),
    null,
    'malformed ref',
  );
  assert.equal(
    await load({ ...baseManifest, generation_issuer_entity_id: 'not-an-entity' }, { verify }),
    null,
    'malformed pinned entity',
  );
  assert.equal(
    await load(baseManifest, { rows: [], verify }),
    null,
    'no locked input row (cross-account)',
  );
  assert.equal(
    await load(baseManifest, {
      rows: [{ manifest: baseManifest, input_hash: 'f'.repeat(64) }],
      verify,
    }),
    null,
    'stored hash mismatch',
  );
  assert.equal(
    await load(baseManifest, { inputHash: 'f'.repeat(64), verify }),
    null,
    'scope hash mismatch',
  );
  assert.equal(
    await load(baseManifest, { inputHash: 'not-a-hash', verify }),
    null,
    'scope hash not canonical',
  );
  assert.equal(
    await load(baseManifest, {
      rows: [{ manifest: { ...baseManifest, kind: 'update' }, input_hash: inputHash }],
      verify,
    }),
    null,
    'manifest hash mismatch',
  );
  assert.equal(
    await load(baseManifest, {
      verify: async () => {
        throw new Error('db down');
      },
    }),
    null,
    'verification failure',
  );
  assert.equal(verifyCalls, 0, 'no re-verification runs before the pinned ref itself is valid');
});

test('a re-verification result is rejected unless it matches the pinned ref, entity and locked materials', async () => {
  const approved = bindingResponse();
  const cases: Array<[string, GenerationIssuerBindingResponse | null, unknown?]> = [
    ['withdrawn binding', null],
    ['different ref version', bindingResponse({ version: 3 })],
    ['different content hash', bindingResponse({ content_sha256: 'f'.repeat(64) })],
    [
      'different approved entity',
      bindingResponse({ issuer_entity_id: 'entity:22222222-2222-4222-8222-222222222222' }),
    ],
    ['null approved entity', bindingResponse({ issuer_entity_id: null })],
    ['pending status', bindingResponse({ status: 'pending' })],
    ['foreign owner', bindingResponse({ owner_user_id: 'other-owner' })],
    ['foreign project', bindingResponse({ project_id: 'other-project' })],
    [
      'last review is not an approval',
      bindingResponse({ review_events: [{ ...approved.review_events[0]!, action: 'withdraw' }] }),
    ],
    [
      'materials conflict',
      approved,
      { ...baseManifest, materials: [{ ...material, sha256: 'f'.repeat(64) }] },
    ],
  ];
  for (const [description, verified, manifest] of cases) {
    const value = await load(manifest ?? baseManifest, { verify: async () => verified });
    assert.equal(value, null, description);
  }
});

test('a valid pinned ref re-verified against the binding own locked input yields the exact approved subject', async () => {
  let seenRef: unknown;
  const value = await load(baseManifest, {
    verify: async (ref) => {
      seenRef = ref;
      return bindingResponse();
    },
  });
  assert.deepEqual(
    seenRef,
    bindingRef,
    'the exact pinned ref is re-verified, never a latest binding',
  );
  assert.deepEqual(value, {
    ownerUserId: scope.ownerUserId,
    projectId: scope.projectId,
    runId: scope.runId,
    inputRevision: scope.inputRevision,
    inputHash,
    bindingId: bindingRef.binding_id,
    version: bindingRef.version,
    contentSha256: contentSha256,
    issuerEntityId: entityId,
    reviewEventId: 'review-synthetic',
    reviewedAt: '2026-09-25T00:00:00Z',
  });
});
