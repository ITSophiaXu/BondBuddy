import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTHORIZED_SAMPLE_CASE_FILES,
  AUTHORIZED_SAMPLE_MANIFEST_SHA256,
} from './authorized-sample-membership.generated.js';
import {
  verifyAuthorizedSampleMembership,
  type AuthorizedSampleMembershipInput,
} from './authorized-sample-membership.js';

const rqFiles = AUTHORIZED_SAMPLE_CASE_FILES.filter((file) => file.caseId === 'rq-202506');
const qxFiles = AUTHORIZED_SAMPLE_CASE_FILES.filter((file) => file.caseId === 'qx-202606');

type MutableInput = {
  ownerUserId: string;
  projectId: string;
  lockedMaterials: Array<{
    material_id: string;
    material_version: number;
    role: string;
    sha256: string;
  }>;
  persistedMaterials: Array<{
    owner_user_id: string;
    project_id: string;
    id: string;
    version: number;
    role: string;
    sha256: string;
  }>;
  grantManifestSha256: string;
};

function input(files: readonly (typeof AUTHORIZED_SAMPLE_CASE_FILES)[number][]): MutableInput {
  const lockedMaterials = files.map((file, index) => ({
    material_id: `synthetic-material-${index}`,
    material_version: 1,
    role: file.uploadRole,
    sha256: file.sha256,
  }));
  const value = {
    ownerUserId: 'synthetic-owner',
    projectId: 'synthetic-project',
    grantManifestSha256: AUTHORIZED_SAMPLE_MANIFEST_SHA256,
    lockedMaterials,
    persistedMaterials: lockedMaterials.map((ref) => ({
      owner_user_id: 'synthetic-owner',
      project_id: 'synthetic-project',
      id: ref.material_id,
      version: ref.material_version,
      role: ref.role,
      sha256: ref.sha256,
    })),
  };
  return value satisfies AuthorizedSampleMembershipInput;
}

test('same-case historical plus financial subset is accepted and missing authorized files stay explicit', () => {
  const result = verifyAuthorizedSampleMembership(input([rqFiles[0]!, rqFiles[1]!]));
  assert.deepEqual(result, {
    accepted: true,
    caseId: 'rq-202506',
    gaps: [
      {
        fileId: 'rq-202506-03',
        role: 'financial',
        reason: 'authorized_sample_material_not_locked',
      },
      { fileId: 'rq-202506-04', role: 'notes', reason: 'authorized_sample_material_not_locked' },
      { fileId: 'rq-202506-05', role: 'notes', reason: 'authorized_sample_material_not_locked' },
    ],
  });
});

test('a complete sample case is accepted without gaps', () => {
  const result = verifyAuthorizedSampleMembership(input(rqFiles));
  assert.deepEqual(result, { accepted: true, caseId: 'rq-202506', gaps: [] });
});

test('grant must pin the exact manifest byte SHA', () => {
  const value = input([rqFiles[0]!, rqFiles[1]!]);
  assert.deepEqual(
    verifyAuthorizedSampleMembership({ ...value, grantManifestSha256: 'a'.repeat(64) }),
    {
      accepted: false,
      reason: 'manifest_hash_mismatch',
    },
  );
});

test('rejects missing minimum roles, unknown extras, role/hash swaps, and mixed cases', () => {
  const historicalOnly = input([rqFiles[0]!]);
  assert.deepEqual(verifyAuthorizedSampleMembership(historicalOnly), {
    accepted: false,
    reason: 'financial_material_required',
  });

  const financialOnly = input([rqFiles[1]!]);
  assert.deepEqual(verifyAuthorizedSampleMembership(financialOnly), {
    accepted: false,
    reason: 'historical_material_required',
  });

  const unknown = input([rqFiles[0]!, rqFiles[1]!]);
  unknown.lockedMaterials[1]!.sha256 = 'a'.repeat(64);
  unknown.persistedMaterials[1]!.sha256 = 'a'.repeat(64);
  assert.deepEqual(verifyAuthorizedSampleMembership(unknown), {
    accepted: false,
    reason: 'sample_material_hash_mismatch',
  });

  const roleMismatch = input([rqFiles[0]!, rqFiles[1]!]);
  roleMismatch.lockedMaterials[1]!.role = 'notes';
  roleMismatch.persistedMaterials[1]!.role = 'notes';
  assert.deepEqual(verifyAuthorizedSampleMembership(roleMismatch), {
    accepted: false,
    reason: 'sample_material_role_mismatch',
  });

  const extra = input([rqFiles[0]!, rqFiles[1]!]);
  extra.lockedMaterials[1]!.sha256 = 'a'.repeat(64);
  extra.persistedMaterials[1]!.sha256 = 'a'.repeat(64);
  extra.lockedMaterials[1]!.material_id = 'synthetic-extra';
  extra.persistedMaterials[1]!.id = 'synthetic-extra';
  assert.deepEqual(verifyAuthorizedSampleMembership(extra), {
    accepted: false,
    reason: 'sample_material_hash_mismatch',
  });

  assert.deepEqual(
    verifyAuthorizedSampleMembership(input([rqFiles[0]!, rqFiles[1]!, qxFiles[1]!])),
    {
      accepted: false,
      reason: 'mixed_sample_cases',
    },
  );
});

test('rejects duplicate locked/persisted identities and unpaired database rows', () => {
  const duplicate = input([rqFiles[0]!, rqFiles[1]!]);
  duplicate.lockedMaterials[1]!.material_id = duplicate.lockedMaterials[0]!.material_id;
  assert.deepEqual(verifyAuthorizedSampleMembership(duplicate), {
    accepted: false,
    reason: 'duplicate_locked_material',
  });

  const duplicateDb = input([rqFiles[0]!, rqFiles[1]!]);
  duplicateDb.persistedMaterials[1]!.id = duplicateDb.persistedMaterials[0]!.id;
  duplicateDb.persistedMaterials[1]!.version = duplicateDb.persistedMaterials[0]!.version;
  assert.deepEqual(verifyAuthorizedSampleMembership(duplicateDb), {
    accepted: false,
    reason: 'duplicate_persisted_material',
  });

  const extraDb = input([rqFiles[0]!, rqFiles[1]!]);
  extraDb.persistedMaterials.push({
    ...extraDb.persistedMaterials[0]!,
    id: 'synthetic-orphan',
    version: 2,
  });
  assert.deepEqual(verifyAuthorizedSampleMembership(extraDb), {
    accepted: false,
    reason: 'persisted_material_set_mismatch',
  });
});

test('rejects binding the same authorized file to two distinct material IDs', () => {
  const sample = input([rqFiles[0]!, rqFiles[1]!]);
  sample.lockedMaterials[1]!.role = rqFiles[0]!.uploadRole;
  sample.lockedMaterials[1]!.sha256 = rqFiles[0]!.sha256;
  sample.persistedMaterials[1]!.role = rqFiles[0]!.uploadRole;
  sample.persistedMaterials[1]!.sha256 = rqFiles[0]!.sha256;
  assert.deepEqual(verifyAuthorizedSampleMembership(sample), {
    accepted: false,
    reason: 'duplicate_sample_material',
  });
});

test('every locked item must match persisted owner, project, version, role, and hash', () => {
  const variants: Array<
    [keyof AuthorizedSampleMembershipInput['persistedMaterials'][number], string, string]
  > = [
    ['owner_user_id', 'other-owner', 'material_owner_mismatch'],
    ['project_id', 'other-project', 'material_project_mismatch'],
    ['version', '2', 'persisted_material_set_mismatch'],
    ['role', 'notes', 'material_role_mismatch'],
    ['sha256', 'a'.repeat(64), 'material_hash_mismatch'],
  ];
  for (const [field, value, reason] of variants) {
    const sample = input([rqFiles[0]!, rqFiles[1]!]);
    (sample.persistedMaterials[0] as Record<string, string | number>)[field] =
      field === 'version' ? Number(value) : value;
    assert.deepEqual(verifyAuthorizedSampleMembership(sample), { accepted: false, reason });
  }
});

test('rejects mismatched locked and persisted metadata before sample membership', () => {
  const sample = input([rqFiles[0]!, rqFiles[1]!]);
  sample.persistedMaterials[0]!.sha256 = 'a'.repeat(64);
  assert.deepEqual(verifyAuthorizedSampleMembership(sample), {
    accepted: false,
    reason: 'material_hash_mismatch',
  });
});
