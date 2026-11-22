import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { Recognition, ReportingPeriod } from '@bondbuddy/contracts';
import {
  createUpdateDifficultySnapshot,
  getCurrentUpdateDifficultySnapshot,
  getUpdateDifficultySnapshot,
  loadLockedUpdateDifficultyInput,
  type UpdateDifficultyClient,
  type UpdateDifficultyDependencies,
  type UpdateDifficultyPool,
  type TrustedUpdateDifficultyInput,
} from './update-difficulty-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('UPDATE_DIFFICULTY_TEST_DATABASE_URL');

const owner = 'difficulty-owner-synthetic';
const project = 'difficulty-project-synthetic';
const historical = 'difficulty-history-synthetic';
const finance = 'difficulty-finance-synthetic';
const evidenceRef = 'difficulty-evidence-period';
const hash = 'a'.repeat(64);
const sourceProvenance = {
  material_id: historical,
  material_version: 1,
  method: 'native_text' as const,
  extractor_version: 'historical-native-recognition-v1/parser-synthetic-1',
  evidence_refs: ['difficulty-evidence-source'],
};
const financeProvenance = {
  material_id: finance,
  material_version: 1,
  method: 'native_text' as const,
  extractor_version: 'parser-synthetic-1',
  evidence_refs: [evidenceRef],
};
const sourceField = <T extends string>(value: T) => ({
  value,
  raw_value: value,
  provenance: sourceProvenance,
  uncertainty: [],
  status: 'recognized' as const,
});
function recognition(state: Recognition['state'] = 'ready'): Recognition {
  return {
    material_id: historical,
    material_version: 1,
    profile_version: 1,
    state,
    source_market: sourceField('sse'),
    source_offering: sourceField('private'),
    reporting_periods: [
      {
        start: '2024-01-01',
        end: '2024-12-31',
        period_kind: 'annual',
        scope: 'consolidated',
        raw_value: '2024 年度',
        provenance: sourceProvenance,
        uncertainty: [],
        status: 'recognized',
      },
    ],
    latest_reporting_cutoff: sourceField('2024-12-31'),
  } as Recognition;
}
const targetPeriod: ReportingPeriod = {
  start: '2025-01-01',
  end: '2025-12-31',
  period_kind: 'annual',
  scope: 'consolidated',
  raw_value: '2025 年度',
  provenance: financeProvenance,
  uncertainty: [],
  status: 'recognized',
} as ReportingPeriod;
function input(
  overrides: Partial<TrustedUpdateDifficultyInput> = {},
): TrustedUpdateDifficultyInput {
  return {
    ownerUserId: owner,
    projectId: project,
    source: { materialId: historical, materialVersion: 1, profileVersion: 1 },
    targetRevision: 4,
    financialMaterialVersions: [{ materialId: finance, materialVersion: 1 }],
    targetReportingPeriods: [targetPeriod],
    replacements: [],
    restatements: [],
    requestId: 'difficulty-request-synthetic',
    ...overrides,
  };
}

class TxMock implements UpdateDifficultyClient {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  readonly snapshots: Record<string, unknown>[] = [];
  readonly outbox: Record<string, unknown>[] = [];
  readonly active = true;
  readonly profile = recognition();
  currentInputRevision: number | null = null;
  lockedInput: Record<string, unknown> | null = null;
  lockedMaterials: Record<string, unknown>[] = [];
  targetConfirmationRows: Record<string, unknown>[] = [];
  private backup: {
    snapshots: Record<string, unknown>[];
    outbox: Record<string, unknown>[];
  } | null = null;
  released = false;
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') {
      this.backup = {
        snapshots: structuredClone(this.snapshots),
        outbox: structuredClone(this.outbox),
      };
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.backup = null;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (this.backup) {
        this.snapshots.splice(0, this.snapshots.length, ...this.backup.snapshots);
        this.outbox.splice(0, this.outbox.length, ...this.backup.outbox);
      }
      this.backup = null;
      return { rows: [] };
    }
    if (sql.includes('SELECT draft_revision,latest_input_revision FROM bb_projects'))
      return { rows: [{ draft_revision: 4, latest_input_revision: this.currentInputRevision }] };
    if (sql.includes('FROM bb_projects') && sql.includes('draft_revision'))
      return {
        rows: [
          {
            market: 'sse',
            offering: 'private',
            draft_revision: 4,
            latest_input_revision: this.currentInputRevision,
          },
        ],
      };
    if (sql.includes('FROM bb_projects') && sql.includes('FOR UPDATE'))
      return {
        rows: this.active && values[0] === owner && values[1] === project ? [{ id: project }] : [],
      };
    if (sql.includes('FROM bb_input_revisions') && sql.includes('SELECT input_hash'))
      return { rows: this.lockedInput ? [this.lockedInput] : [] };
    if (sql.includes('FROM bb_input_revision_target_confirmations'))
      return {
        rows: this.targetConfirmationRows.filter(
          (row) =>
            row.owner_user_id === values[0] &&
            row.project_id === values[1] &&
            Number(row.input_revision) === Number(values[2]),
        ),
      };
    if (sql.includes('SELECT m.id,m.version,m.role,m.sha256'))
      return { rows: this.lockedMaterials };
    if (sql.includes('FROM bb_target_period_evidence_decisions')) return { rows: [] };
    if (sql.includes('SELECT profile_version FROM bb_historical_profiles'))
      return { rows: [{ profile_version: 1 }] };
    if (sql.includes('FROM bb_update_difficulty_snapshots') && sql.includes('request_id=$3'))
      return {
        rows: this.snapshots.filter(
          (row) =>
            row.owner_user_id === values[0] &&
            row.project_id === values[1] &&
            row.request_id === values[2],
        ),
      };
    if (
      sql.includes('FROM bb_update_difficulty_snapshots') &&
      sql.includes('source_profile_version=$5')
    )
      return {
        rows: this.snapshots.filter(
          (row) =>
            row.owner_user_id === values[0] &&
            row.project_id === values[1] &&
            row.source_material_id === values[2] &&
            row.source_material_version === values[3] &&
            row.source_profile_version === values[4] &&
            row.target_revision === values[5],
        ),
      };
    if (sql.includes('FROM bb_historical_profiles'))
      return { rows: [{ recognition: this.profile, profile_state: this.profile.state }] };
    if (sql.includes('FROM bb_material_versions') && sql.includes('SELECT m.role'))
      return { rows: [{ role: 'financial' }] };
    if (sql.includes('FROM bb_parse_evidence') || sql.includes('FROM bb_parse_snapshots'))
      return { rows: [{ ok: 1 }] };
    if (sql.includes('INSERT INTO bb_update_difficulty_snapshots')) {
      const row = {
        id: values[0],
        owner_user_id: values[1],
        project_id: values[2],
        request_id: values[3],
        request_hash: values[4],
        source_material_id: values[5],
        source_material_version: values[6],
        source_profile_version: values[7],
        target_revision: values[8],
        source_market: values[9],
        source_offering: values[10],
        target_market: values[11],
        target_offering: values[12],
        input_revision: values[13],
        input_hash: values[14],
        evidence_identity: values[15],
        financial_material_versions: JSON.parse(String(values[16])),
        comparison_input: JSON.parse(String(values[17])),
        old_profile_completeness: values[18],
        estimate: JSON.parse(String(values[19])),
        created_at: new Date('2026-09-24T00:00:00Z'),
      };
      this.snapshots.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      this.outbox.push({
        id: values[0],
        owner_user_id: values[1],
        aggregate_id: values[2],
        event_type: 'project.update_difficulty_snapshotted',
        payload: JSON.parse(String(values[3])),
      });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  release(): void {
    this.released = true;
  }
}
function dependencies(client: TxMock): UpdateDifficultyDependencies {
  let nextId = 0;
  return {
    pool: { connect: async () => client, query: (sql, values = []) => client.query(sql, values) },
    newId: () => `difficulty-id-${++nextId}`,
  };
}

test('durable adapter composes legacy v1 source and target evidence into one immutable comparison', async () => {
  const client = new TxMock();
  const deps = dependencies(client);
  const first = await createUpdateDifficultySnapshot(deps, input());
  assert.equal(
    client.profile.source_market.provenance.extractor_version,
    'historical-native-recognition-v1/parser-synthetic-1',
    'legacy profiles remain evidence-verifiable',
  );
  assert.equal(first.estimate.status, 'ready');
  assert.equal(first.estimate.estimatedN, 1);
  assert.equal(first.oldProfileCompleteness, 'undetermined');
  assert.deepEqual(first.financialMaterialVersions, [{ materialId: finance, materialVersion: 1 }]);
  assert.equal(client.snapshots.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.match(
    client.calls.find(
      (call) => call.sql.includes('FROM bb_projects') && call.sql.includes('FOR UPDATE'),
    )!.sql,
    /owner_user_id=\$1 AND id=\$2 AND deleted_at IS NULL FOR UPDATE/,
  );
  assert.equal(client.released, true);
});

test('same request/payload replays once; changed payload and competing target snapshots fail closed', async () => {
  const client = new TxMock();
  const deps = dependencies(client);
  const saved = await createUpdateDifficultySnapshot(deps, input());
  const replay = await createUpdateDifficultySnapshot(deps, input());
  assert.equal(replay.id, saved.id);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    createUpdateDifficultySnapshot(deps, input({ targetReportingPeriods: [] })),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    createUpdateDifficultySnapshot(deps, input({ requestId: 'other-request' })),
    /TARGET_REVISION_ALREADY_SNAPSHOTTED/,
  );
  assert.equal(client.snapshots.length, 1);
  assert.equal(client.outbox.length, 1);
});

test('uncertain source or unanchored target periods retain a null estimate', async () => {
  const client = new TxMock();
  (client as unknown as { profile: Recognition }).profile = {
    ...recognition('needs_confirmation'),
    source_market: { ...sourceField('sse'), status: 'user_asserted' },
  };
  const result = await createUpdateDifficultySnapshot(
    dependencies(client),
    input({ requestId: 'uncertain-request' }),
  );
  assert.equal(result.estimate.status, 'needs_confirmation');
  assert.equal(result.estimate.estimatedN, null);
  assert.ok(result.estimate.confirmationReasons.includes('source_profile_needs_confirmation'));
  const targetClient = new TxMock();
  const unanchored = await createUpdateDifficultySnapshot(
    dependencies(targetClient),
    input({
      requestId: 'unanchored-request',
      targetReportingPeriods: [
        { ...targetPeriod, provenance: { ...financeProvenance, evidence_refs: [] } },
      ],
    }),
  );
  assert.equal(unanchored.estimate.status, 'needs_confirmation');
  assert.equal(unanchored.estimate.estimatedN, null);
  assert.ok(
    unanchored.estimate.confirmationReasons.includes('period_evidence_missing_or_unverified'),
  );
  const forgedClient = new TxMock();
  (forgedClient as unknown as { profile: Recognition }).profile = {
    ...recognition(),
    source_offering: {
      ...sourceField('private'),
      provenance: { ...sourceProvenance, material_id: 'foreign-source-material' },
    },
  };
  const forged = await createUpdateDifficultySnapshot(
    dependencies(forgedClient),
    input({ requestId: 'forged-source-anchor-request' }),
  );
  assert.equal(forged.estimate.status, 'needs_confirmation');
  assert.equal(forged.estimate.estimatedN, null);
});

test('input revision hash/draft/material binding is checked before an estimate', async () => {
  const client = new TxMock();
  client.currentInputRevision = 2;
  client.query = async (sql, values: unknown[] = []) => {
    if (sql.includes('FROM bb_input_revisions') && sql.includes('SELECT input_hash'))
      return {
        rows: [
          {
            input_hash: 'b'.repeat(64),
            draft_revision: 4,
            material_versions: [{ material_id: finance, material_version: 1 }],
          },
        ],
      };
    return TxMock.prototype.query.call(client, sql, values) as Promise<{
      rows: Record<string, unknown>[];
    }>;
  };
  await assert.rejects(
    createUpdateDifficultySnapshot(
      dependencies(client),
      input({ inputRevision: 2, inputHash: hash }),
    ),
    /TARGET_INPUT_REVISION_MISMATCH/,
  );
});

test('locked input assembler derives source, financial materials and user asserted target periods from the owner scoped manifest', async () => {
  const client = new TxMock();
  const confirmedAt = '2026-09-27T00:00:00.000Z';
  const lockedPeriod = {
    start: '2025-01-01',
    end: '2025-12-31',
    period_kind: 'annual',
    scope: 'consolidated',
    status: 'user_asserted',
    evidence_refs: [],
  };
  const targetConfirmation = {
    status: 'confirmed',
    market: 'sse',
    offering: 'private',
    document_purpose: null,
    as_of: null,
    target_reporting_periods: [lockedPeriod],
    confirmed_by: owner,
    confirmed_at: confirmedAt,
  };
  const manifest = {
    draft_revision: 4,
    kind: 'update',
    materials: [
      { material_id: historical, material_version: 1, role: 'historical', sha256: hash },
      { material_id: finance, material_version: 1, role: 'financial', sha256: hash },
    ],
    market: 'sse',
    offering: 'private',
    target_confirmation: targetConfirmation,
    update_details: { target_reporting_periods: [lockedPeriod] },
  };
  client.currentInputRevision = 2;
  client.lockedInput = {
    input_hash: hash,
    draft_revision: 4,
    manifest,
    material_versions: [
      { material_id: historical, material_version: 1 },
      { material_id: finance, material_version: 1 },
    ],
  };
  client.targetConfirmationRows = [
    {
      owner_user_id: owner,
      project_id: project,
      input_revision: 2,
      market: 'sse',
      offering: 'private',
      document_purpose: null,
      as_of: null,
      target_reporting_periods: [lockedPeriod],
      confirmed_by: owner,
      confirmed_at: new Date(confirmedAt),
    },
  ];
  client.lockedMaterials = [
    { id: historical, version: 1, role: 'historical', sha256: hash },
    { id: finance, version: 1, role: 'financial', sha256: hash },
  ];
  const assembled = await loadLockedUpdateDifficultyInput(dependencies(client), {
    ownerUserId: owner,
    projectId: project,
    inputRevision: 2,
    inputHash: hash,
    requestId: 'locked-request-synthetic',
  });
  assert.deepEqual(assembled.source, {
    materialId: historical,
    materialVersion: 1,
    profileVersion: 1,
  });
  assert.deepEqual(assembled.financialMaterialVersions, [
    { materialId: finance, materialVersion: 1 },
  ]);
  assert.deepEqual(assembled.targetReportingPeriods, [
    {
      start: '2025-01-01',
      end: '2025-12-31',
      period_kind: 'annual',
      scope: 'consolidated',
      status: 'user_asserted',
      evidence_refs: [],
    },
  ]);
  assert.deepEqual(
    assembled.targetConfirmation,
    targetConfirmation,
    'the confirmed user intent is read from its owner/revision scoped immutable row and matches the manifest',
  );
  const snapshot = await createUpdateDifficultySnapshot(dependencies(client), assembled);
  assert.equal(snapshot.estimate.status, 'needs_confirmation');
  assert.equal(snapshot.estimate.estimatedN, null);
  assert.ok(
    snapshot.estimate.confirmationReasons.includes('period_evidence_missing_or_unverified'),
  );
  assert.deepEqual(
    snapshot.comparisonInput.targetConfirmation,
    targetConfirmation,
    'the intent decision is retained in the snapshot without promoting target periods to recognized facts',
  );

  const unconfirmedClient = new TxMock();
  unconfirmedClient.currentInputRevision = 2;
  unconfirmedClient.lockedInput = {
    ...client.lockedInput,
    manifest: {
      ...manifest,
      target_confirmation: {
        status: 'unconfirmed',
        market: null,
        offering: null,
        document_purpose: null,
        as_of: null,
        target_reporting_periods: [],
        confirmed_by: null,
        confirmed_at: null,
      },
    },
  };
  unconfirmedClient.lockedMaterials = client.lockedMaterials;
  const pendingTarget = await loadLockedUpdateDifficultyInput(dependencies(unconfirmedClient), {
    ownerUserId: owner,
    projectId: project,
    inputRevision: 2,
    inputHash: hash,
    requestId: 'unconfirmed-locked-request',
  });
  assert.equal(
    pendingTarget.targetConfirmation,
    undefined,
    'preflight may retain a locked but unattested target',
  );

  const missingRowClient = new TxMock();
  missingRowClient.currentInputRevision = 2;
  missingRowClient.lockedInput = client.lockedInput;
  missingRowClient.lockedMaterials = client.lockedMaterials;
  await assert.rejects(
    loadLockedUpdateDifficultyInput(dependencies(missingRowClient), {
      ownerUserId: owner,
      projectId: project,
      inputRevision: 2,
      inputHash: hash,
      requestId: 'missing-confirmation-row-request',
    }),
    /TARGET_CONFIRMATION_INVALID/,
  );

  const staleClient = new TxMock();
  staleClient.currentInputRevision = 2;
  staleClient.lockedInput = client.lockedInput;
  staleClient.lockedMaterials = client.lockedMaterials;
  staleClient.targetConfirmationRows = [
    { ...client.targetConfirmationRows[0], confirmed_at: new Date('2026-09-26T00:00:00.000Z') },
  ];
  await assert.rejects(
    loadLockedUpdateDifficultyInput(dependencies(staleClient), {
      ownerUserId: owner,
      projectId: project,
      inputRevision: 2,
      inputHash: hash,
      requestId: 'stale-confirmation-request',
    }),
    /TARGET_CONFIRMATION_INVALID/,
  );
});

test('locked snapshot callers cannot substitute target periods', async () => {
  const client = new TxMock();
  const manifestPeriod = {
    start: '2025-01-01',
    end: '2025-12-31',
    period_kind: 'annual',
    scope: 'consolidated',
    status: 'user_asserted',
    evidence_refs: [],
  };
  const confirmedAt = '2026-09-27T00:00:00.000Z';
  const manifest = {
    draft_revision: 4,
    kind: 'update',
    materials: [
      { material_id: historical, material_version: 1, role: 'historical', sha256: hash },
      { material_id: finance, material_version: 1, role: 'financial', sha256: hash },
    ],
    market: 'sse',
    offering: 'private',
    update_details: { target_reporting_periods: [manifestPeriod] },
    target_confirmation: {
      status: 'confirmed',
      market: 'sse',
      offering: 'private',
      document_purpose: null,
      as_of: null,
      target_reporting_periods: [manifestPeriod],
      confirmed_by: owner,
      confirmed_at: confirmedAt,
    },
  };
  client.currentInputRevision = 2;
  client.lockedInput = {
    input_hash: hash,
    draft_revision: 4,
    manifest,
    material_versions: [
      { material_id: historical, material_version: 1 },
      { material_id: finance, material_version: 1 },
    ],
  };
  client.lockedMaterials = [
    { id: historical, version: 1, role: 'historical', sha256: hash },
    { id: finance, version: 1, role: 'financial', sha256: hash },
  ];
  client.targetConfirmationRows = [
    {
      owner_user_id: owner,
      project_id: project,
      input_revision: 2,
      market: 'sse',
      offering: 'private',
      document_purpose: null,
      as_of: null,
      target_reporting_periods: manifest.update_details.target_reporting_periods,
      confirmed_by: owner,
      confirmed_at: new Date(confirmedAt),
    },
  ];
  const lockedPeriod = {
    start: '2025-01-01',
    end: '2025-12-31',
    period_kind: 'annual' as const,
    scope: 'consolidated' as const,
    status: 'user_asserted' as const,
    evidence_refs: [] as const,
  };
  await assert.rejects(
    createUpdateDifficultySnapshot(
      dependencies(client),
      input({
        inputRevision: 2,
        inputHash: hash,
        targetReportingPeriods: [{ ...lockedPeriod, end: '2026-12-31' }],
      }),
    ),
    /TARGET_PERIOD_DECISION_ASSEMBLY_MISMATCH/,
  );
});

test('locked assembler rejects non-update and malformed target period manifests', async () => {
  const validPeriod = {
    start: '2025-01-01',
    end: '2025-12-31',
    period_kind: 'annual',
    scope: 'consolidated',
    status: 'user_asserted',
    evidence_refs: [],
  };
  const invalidCases = [
    {
      manifest: { kind: 'review', update_details: { target_reporting_periods: [validPeriod] } },
      expected: /TARGET_INPUT_MANIFEST_INVALID/,
    },
    {
      manifest: {
        kind: 'update',
        update_details: {
          target_reporting_periods: [{ ...validPeriod, start: '2026-12-31', end: '2025-12-31' }],
        },
      },
      expected: /TARGET_INPUT_MANIFEST_INVALID/,
    },
    {
      manifest: {
        kind: 'update',
        update_details: { target_reporting_periods: [{ ...validPeriod, end: '2025-02-30' }] },
      },
      expected: /TARGET_INPUT_MANIFEST_INVALID/,
    },
    {
      manifest: {
        kind: 'update',
        update_details: { target_reporting_periods: [validPeriod, validPeriod] },
      },
      expected: /TARGET_INPUT_MANIFEST_INVALID/,
    },
    {
      manifest: {
        kind: 'update',
        update_details: { target_reporting_periods: [{ ...validPeriod, status: undefined }] },
      },
      expected: /TARGET_INPUT_MANIFEST_INVALID/,
    },
  ];
  for (const [index, invalid] of invalidCases.entries()) {
    const client = new TxMock();
    client.currentInputRevision = 2;
    const materials = [
      { material_id: historical, material_version: 1, role: 'historical', sha256: hash },
      { material_id: finance, material_version: 1, role: 'financial', sha256: hash },
    ];
    client.lockedInput = {
      input_hash: hash,
      draft_revision: 4,
      manifest: {
        draft_revision: 4,
        materials,
        ...invalid.manifest,
      },
      material_versions: [
        { material_id: historical, material_version: 1 },
        { material_id: finance, material_version: 1 },
      ],
    };
    client.lockedMaterials = [
      { id: historical, version: 1, role: 'historical', sha256: hash },
      { id: finance, version: 1, role: 'financial', sha256: hash },
    ];
    await assert.rejects(
      loadLockedUpdateDifficultyInput(dependencies(client), {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 2,
        inputHash: hash,
        requestId: `invalid-lock-${index}`,
      }),
      invalid.expected,
    );
  }
});

test(
  'live PostgreSQL 16 persists snapshot plus outbox, enforces immutability and scopes reads',
  {
    skip: !testDatabaseUrl && 'set UPDATE_DIFFICULTY_TEST_DATABASE_URL for migrated PostgreSQL 16',
  },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const suffix = (await import('node:crypto')).randomUUID();
    const connection = await pool.connect();
    await connection.query('BEGIN');
    const savepoint = 'update_difficulty_snapshot';
    const wrapped: UpdateDifficultyClient = {
      query: async (sql, values = []) => {
        if (sql === 'BEGIN')
          return connection.query(`SAVEPOINT ${savepoint}`) as unknown as Promise<{
            rows: Record<string, unknown>[];
          }>;
        if (sql === 'COMMIT')
          return connection.query(`RELEASE SAVEPOINT ${savepoint}`) as unknown as Promise<{
            rows: Record<string, unknown>[];
          }>;
        if (sql === 'ROLLBACK') {
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          return connection.query(`RELEASE SAVEPOINT ${savepoint}`) as unknown as Promise<{
            rows: Record<string, unknown>[];
          }>;
        }
        return connection.query(sql, values) as unknown as Promise<{
          rows: Record<string, unknown>[];
        }>;
      },
      release: () => undefined,
    };
    let idSequence = 0;
    const scoped: UpdateDifficultyDependencies = {
      pool: { connect: async () => wrapped, query: (sql, values) => wrapped.query(sql, values) },
      newId: () => `difficulty-live-${suffix}-${++idSequence}`,
    };
    const liveOwner = `difficulty-owner-${suffix}`,
      liveProject = `difficulty-project-${suffix}`;
    const histUpload = `difficulty-h-upload-${suffix}`,
      hist = `difficulty-history-${suffix}`;
    const finUpload = `difficulty-f-upload-${suffix}`,
      fin = `difficulty-financial-${suffix}`;
    const parserHash = 'c'.repeat(64),
      sourceSnap = `difficulty-source-snap-${suffix}`,
      targetSnap = `difficulty-target-snap-${suffix}`;
    try {
      await connection.query(
        `INSERT INTO bb_projects(id,owner_user_id,name,kind,market,offering) VALUES($1,$2,'synthetic','update','sse','private')`,
        [liveProject, liveOwner],
      );
      await connection.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'historical.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,'historical',$5,now()+interval '1 hour','completed')`,
        [histUpload, liveOwner, liveProject, hash, `synthetic/${suffix}/h`],
      );
      await connection.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','historical.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$5,$6,'parsed')`,
        [
          hist,
          liveOwner,
          liveProject,
          histUpload,
          hash,
          `users/${liveOwner}/projects/${liveProject}/h`,
        ],
      );
      await connection.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'financial.pdf','application/pdf',10,$4,'financial',$5,now()+interval '1 hour','completed')`,
        [finUpload, liveOwner, liveProject, hash, `synthetic/${suffix}/f`],
      );
      await connection.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'financial','financial.pdf','application/pdf',10,$5,$6,'parsed')`,
        [
          fin,
          liveOwner,
          liveProject,
          finUpload,
          hash,
          `users/${liveOwner}/projects/${liveProject}/f`,
        ],
      );
      const addSnapshot = async (id: string, materialId: string, recordIds: string[]) => {
        await connection.query(
          `INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,'parser-synthetic-1',$6,'{}','parsed','document-parse-response-v1',$7,$8,$9::jsonb)`,
          [
            id,
            liveOwner,
            liveProject,
            materialId,
            hash,
            'd'.repeat(64),
            'e'.repeat(64),
            recordIds.length,
            JSON.stringify({
              schema_version: 'document-parse-response-v1',
              request_id: `${id}-request`,
              parser_version: 'parser-synthetic-1',
              status: 'parsed',
              material: {
                material_id: materialId,
                material_version: 1,
                media_type:
                  materialId === hist
                    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                    : 'application/pdf',
                sha256: hash,
              },
              warnings: [],
              document: { page_count: materialId === hist ? null : 1 },
              error: null,
            }),
          ],
        );
        for (const [ordinal, recordId] of recordIds.entries())
          await connection.query(
            `INSERT INTO bb_parse_evidence
        (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,'2024 annual report','synthetic','native_text','parser-synthetic-1',1,'[]','{}',$9,$10)`,
            [
              liveOwner,
              liveProject,
              materialId,
              id,
              recordId,
              hash,
              materialId === hist ? 'docx_block' : 'pdf_bbox',
              JSON.stringify(
                materialId === hist
                  ? { block_index: ordinal }
                  : { page: 1, x0: 1, y0: 1, x1: 10, y1: 10 },
              ),
              'f'.repeat(64),
              ordinal,
            ],
          );
      };
      await addSnapshot(sourceSnap, hist, ['src-market', 'src-offering', 'src-period']);
      await addSnapshot(targetSnap, fin, ['target-period']);
      const liveRecognition = recognition();
      liveRecognition.material_id = hist;
      liveRecognition.profile_version = 1;
      const remap = (refs: string[]) => ({
        ...sourceProvenance,
        material_id: hist,
        material_version: 1,
        evidence_refs: refs,
      });
      liveRecognition.source_market.provenance = remap(['src-market']);
      liveRecognition.source_offering.provenance = remap(['src-offering']);
      liveRecognition.latest_reporting_cutoff.provenance = remap(['src-period']);
      liveRecognition.reporting_periods[0]!.provenance = remap(['src-period']);
      await connection.query(
        `INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES($1,$2,$3,1,1,$4,$5,'recognition',$6::jsonb)`,
        [liveOwner, liveProject, hist, `profile-${suffix}`, hash, JSON.stringify(liveRecognition)],
      );
      const period = {
        ...targetPeriod,
        provenance: {
          ...financeProvenance,
          material_id: fin,
          material_version: 1,
          evidence_refs: ['target-period'],
        },
      };
      const liveInput = {
        ...input({ requestId: `request-${suffix}` }),
        ownerUserId: liveOwner,
        projectId: liveProject,
        source: { materialId: hist, materialVersion: 1, profileVersion: 1 },
        financialMaterialVersions: [{ materialId: fin, materialVersion: 1 }],
        targetRevision: 1,
        targetReportingPeriods: [period],
      };
      const saved = await createUpdateDifficultySnapshot(scoped, liveInput);
      assert.equal(saved.estimate.estimatedN, 1);
      assert.equal(
        (await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: saved.id,
        })) !== null,
        true,
      );
      await connection.query(`SAVEPOINT difficulty_immutable_check`);
      await assert.rejects(
        connection.query(
          `UPDATE bb_update_difficulty_snapshots SET estimate=estimate WHERE id=$1`,
          [saved.id],
        ),
        /immutable/,
      );
      await connection.query(`ROLLBACK TO SAVEPOINT difficulty_immutable_check`);
      await connection.query(`RELEASE SAVEPOINT difficulty_immutable_check`);
      assert.equal(
        await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: 'foreign-owner',
          projectId: liveProject,
          snapshotId: saved.id,
        }),
        null,
      );
      assert.equal(
        (
          await connection.query(
            `SELECT count(*)::int AS count FROM bb_outbox WHERE aggregate_id=$1 AND event_type='project.update_difficulty_snapshotted'`,
            [liveProject],
          )
        ).rows[0]!.count,
        1,
      );

      const lockedTarget = {
        start: '2025-01-01',
        end: '2025-12-31',
        period_kind: 'annual',
        scope: 'consolidated',
        status: 'user_asserted',
        evidence_refs: [],
      };
      const confirmedAt = '2026-09-27T00:00:00.000Z';
      const targetConfirmation = (target: typeof lockedTarget) => ({
        status: 'confirmed',
        market: 'sse',
        offering: 'private',
        document_purpose: null,
        as_of: null,
        target_reporting_periods: [target],
        confirmed_by: liveOwner,
        confirmed_at: confirmedAt,
      });
      const lockManifest = (financeId: string, target: typeof lockedTarget) => ({
        draft_revision: 1,
        kind: 'update',
        market: 'sse',
        offering: 'private',
        materials: [
          { material_id: hist, material_version: 1, role: 'historical', sha256: hash },
          { material_id: financeId, material_version: 1, role: 'financial', sha256: hash },
        ],
        target_confirmation: targetConfirmation(target),
        update_details: { target_reporting_periods: [target] },
      });
      const lockRefs = (financeId: string) =>
        JSON.stringify([
          { material_id: hist, material_version: 1 },
          { material_id: financeId, material_version: 1 },
        ]);
      const persistTargetConfirmation = async (revision: number, target: typeof lockedTarget) =>
        connection.query(
          `
      INSERT INTO bb_input_revision_target_confirmations
        (owner_user_id,project_id,input_revision,market,offering,document_purpose,as_of,target_reporting_periods,confirmed_by,confirmed_at)
      VALUES($1,$2,$3,'sse','private',NULL,NULL,$4::jsonb,$5,$6)`,
          [liveOwner, liveProject, revision, JSON.stringify([target]), liveOwner, confirmedAt],
        );
      await connection.query(
        `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
        [
          liveProject,
          liveOwner,
          'b'.repeat(64),
          JSON.stringify(lockManifest(fin, lockedTarget)),
          lockRefs(fin),
        ],
      );
      await persistTargetConfirmation(1, lockedTarget);
      await connection.query(
        `UPDATE bb_projects SET latest_input_revision=1 WHERE owner_user_id=$1 AND id=$2`,
        [liveOwner, liveProject],
      );
      assert.equal(
        (await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: saved.id,
        })) !== null,
        true,
        'historical by-id reads retain an immutable prior snapshot',
      );
      assert.equal(
        await getCurrentUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: saved.id,
        }),
        null,
      );
      const assembled = await loadLockedUpdateDifficultyInput(scoped, {
        ownerUserId: liveOwner,
        projectId: liveProject,
        inputRevision: 1,
        inputHash: 'b'.repeat(64),
        requestId: `locked-request-${suffix}`,
      });
      assert.deepEqual(assembled.targetReportingPeriods, [{ ...lockedTarget }]);
      const lockedSnapshot = await createUpdateDifficultySnapshot(scoped, assembled);
      assert.equal(lockedSnapshot.estimate.status, 'needs_confirmation');
      assert.equal(lockedSnapshot.estimate.estimatedN, null);
      assert.equal(
        (await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: lockedSnapshot.id,
        })) !== null,
        true,
      );

      const replacementUpload = `difficulty-f2-upload-${suffix}`,
        replacementFinance = `difficulty-financial-v2-${suffix}`;
      await connection.query(
        `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'financial-replacement.pdf','application/pdf',10,$4,'financial',$5,now()+interval '1 hour','completed')`,
        [replacementUpload, liveOwner, liveProject, hash, `synthetic/${suffix}/f2`],
      );
      await connection.query(
        `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'financial','financial-replacement.pdf','application/pdf',10,$5,$6,'parsed')`,
        [
          replacementFinance,
          liveOwner,
          liveProject,
          replacementUpload,
          hash,
          `users/${liveOwner}/projects/${liveProject}/f2`,
        ],
      );
      const replacementTarget = { ...lockedTarget, end: '2026-12-31', start: '2026-01-01' };
      await connection.query(
        `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,2,$2,1,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)`,
        [
          liveProject,
          liveOwner,
          'c'.repeat(64),
          JSON.stringify(lockManifest(replacementFinance, replacementTarget)),
          lockRefs(replacementFinance),
        ],
      );
      await persistTargetConfirmation(2, replacementTarget);
      await connection.query(
        `UPDATE bb_projects SET latest_input_revision=2 WHERE owner_user_id=$1 AND id=$2`,
        [liveOwner, liveProject],
      );
      assert.equal(
        (await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: lockedSnapshot.id,
        })) !== null,
        true,
        'the immutable row remains readable by id',
      );
      assert.equal(
        await getCurrentUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: lockedSnapshot.id,
        }),
        null,
        'a replacement material and changed target lock make the old snapshot unavailable as current',
      );
      assert.equal(
        (
          await connection.query(
            `SELECT count(*)::int AS count FROM bb_update_difficulty_snapshots WHERE id=$1`,
            [lockedSnapshot.id],
          )
        ).rows[0]!.count,
        1,
        'stale immutable snapshot remains retained',
      );

      const replacementInput = await loadLockedUpdateDifficultyInput(scoped, {
        ownerUserId: liveOwner,
        projectId: liveProject,
        inputRevision: 2,
        inputHash: 'c'.repeat(64),
        requestId: `replacement-request-${suffix}`,
      });
      const profileBoundSnapshot = await createUpdateDifficultySnapshot(scoped, replacementInput);
      assert.equal(profileBoundSnapshot.sourceProfileVersion, 1);

      const nextProfile = structuredClone(liveRecognition);
      nextProfile.profile_version = 2;
      await connection.query(
        `INSERT INTO bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version,request_id,request_hash,write_kind,recognition)
      VALUES($1,$2,$3,1,2,$4,$5,'recognition',$6::jsonb)`,
        [
          liveOwner,
          liveProject,
          hist,
          `profile-v2-${suffix}`,
          '1'.repeat(64),
          JSON.stringify(nextProfile),
        ],
      );
      assert.equal(
        await getCurrentUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: profileBoundSnapshot.id,
        }),
        null,
        'a newer source profile makes the prior profile-bound snapshot unavailable as current',
      );
      assert.equal(
        (await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          snapshotId: profileBoundSnapshot.id,
        })) !== null,
        true,
      );
      assert.equal(
        (
          await connection.query(
            `SELECT count(*)::int AS count FROM bb_update_difficulty_snapshots WHERE id=$1`,
            [profileBoundSnapshot.id],
          )
        ).rows[0]!.count,
        1,
      );
      assert.equal(
        await loadLockedUpdateDifficultyInput(scoped, {
          ownerUserId: liveOwner,
          projectId: liveProject,
          inputRevision: 2,
          inputHash: 'c'.repeat(64),
          requestId: `stale-profile-${suffix}`,
        }).then((value) => value.source.profileVersion),
        2,
      );
      assert.equal(
        await getUpdateDifficultySnapshot(scoped, {
          ownerUserId: 'foreign-owner',
          projectId: liveProject,
          snapshotId: lockedSnapshot.id,
        }),
        null,
        'snapshot reads remain owner scoped',
      );
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  },
);
