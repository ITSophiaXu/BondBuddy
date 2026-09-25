import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { factIdentityKey, type FactCandidate, type FactIdentity } from '@bondbuddy/domain/facts';
import { insertFactCandidate, type FactEvidenceAnchor } from './fact-repository.js';
import {
  appendFactDecision,
  getLatestFactDecision,
  type FactDecisionClient,
  type FactDecisionDependencies,
  type FactDecisionInput,
  type TrustedFactDecisionContext,
} from './fact-decision-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('FACT_DECISION_TEST_DATABASE_URL');

const context: TrustedFactDecisionContext = {
  ownerUserId: 'owner-a', projectId: 'project-a', actorId: 'user-a', actorKind: 'user',
};
const identity: FactIdentity = {
  accountId: 'owner-a', entityId: 'issuer-1', scope: 'consolidated', metric: 'revenue',
  period: { start: '2024-01-01', end: '2024-12-31' }, currency: 'CNY', unit: 'yuan', basis: 'audited', dataVersion: 'v1',
};
const otherIdentity: FactIdentity = { ...identity, scope: 'parent_company' };
const factKeyHash = (value: FactIdentity) => {
  // Candidate persistence hashes the canonical domain identity key.
  return createHash('sha256').update(factIdentityKey(value)).digest('hex');
};

const candidates = [
  {
    id: 'candidate-a', owner_user_id: context.ownerUserId, project_id: context.projectId,
    entity_id: identity.entityId, fact_key_hash: factKeyHash(identity), fact_key: identity,
    value_decimal: '123.00', value_text: null, value_kind: 'decimal', source_kind: 'audited', source_ref: 'audit-v1',
    status: 'extracted', source_observed_at: new Date('2025-03-20T10:00:00Z'), source_valid_as_of: '2024-12-31',
    material_id: 'material-a', material_version: 1, evidence: [{ evidence_id: 'evidence-a', literal_quote: '收入123.00' }],
    uncertainty: [], created_at: new Date('2025-03-20T10:00:00Z'),
  },
  {
    id: 'candidate-user', owner_user_id: context.ownerUserId, project_id: context.projectId,
    entity_id: identity.entityId, fact_key_hash: factKeyHash(identity), fact_key: identity,
    value_decimal: '125.00', value_text: null, value_kind: 'decimal', source_kind: 'user_statement', source_ref: 'chat-1',
    status: 'user_asserted', source_observed_at: new Date('2025-03-21T10:00:00Z'), source_valid_as_of: null,
    material_id: 'material-a', material_version: 1, evidence: [{ evidence_id: 'evidence-user', literal_quote: '收入125.00' }],
    uncertainty: [], created_at: new Date('2025-03-21T10:00:00Z'),
  },
];

function makeDecision(overrides: Partial<FactDecisionInput> = {}): FactDecisionInput {
  return {
    decisionId: 'decision-1', requestId: 'request-1', identity, resolution: 'selected',
    selectedCandidateId: 'candidate-a', reason: '采用审计报告的合并口径数字', ...overrides,
  };
}

class TransactionMock implements FactDecisionClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly decisions: Record<string, unknown>[] = [];
  readonly outbox: Record<string, unknown>[] = [];
  readonly candidates = structuredClone(candidates) as Record<string, unknown>[];
  failOutbox = false;
  released = false;
  private beforeTransaction: { decisions: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') {
      this.beforeTransaction = { decisions: structuredClone(this.decisions), outbox: structuredClone(this.outbox) };
      return { rows: [] };
    }
    if (sql === 'COMMIT') { this.beforeTransaction = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.beforeTransaction) {
        this.decisions.splice(0, this.decisions.length, ...this.beforeTransaction.decisions);
        this.outbox.splice(0, this.outbox.length, ...this.beforeTransaction.outbox);
      }
      this.beforeTransaction = null;
      return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM bb_fact_decisions') && sql.includes('request_id = $3')) {
      return { rows: this.decisions.filter((row) => row.owner_user_id === values[0] && row.project_id === values[1] && row.request_id === values[2]) };
    }
    if (sql.includes('FROM bb_fact_decisions') && sql.includes('ORDER BY version DESC LIMIT 1')) {
      const rows = this.decisions.filter((row) => row.owner_user_id === values[0] && row.project_id === values[1] && row.fact_key_hash === values[2])
        .sort((left, right) => Number(right.version) - Number(left.version));
      return { rows: rows.slice(0, 1) };
    }
    if (sql.includes('FROM bb_fact_candidates')) {
      const rows = this.candidates.filter((candidate) => candidate.owner_user_id === values[0] &&
        candidate.project_id === values[1] && (sql.includes('fact_key_hash = $3')
          ? candidate.fact_key_hash === values[2] : candidate.id === values[2]));
      return { rows: sql.includes('LIMIT 1') ? rows.slice(0, 1) : rows };
    }
    if (sql.includes('COALESCE(max(version)')) {
      const matching = this.decisions.filter((row) => row.owner_user_id === values[0] && row.project_id === values[1] && row.fact_key_hash === values[2]);
      return { rows: [{ version: matching.reduce((max, row) => Math.max(max, Number(row.version)), 0) }] };
    }
    if (sql.startsWith('INSERT INTO bb_fact_decisions')) {
      const row: Record<string, unknown> = {
        id: values[0], request_id: values[1], owner_user_id: values[2], project_id: values[3], fact_key_hash: values[4],
        fact_key: JSON.parse(String(values[5])), version: values[6], resolution: values[7], selected_candidate_id: values[8],
        selected_candidate_provenance: values[9] === null ? null : JSON.parse(String(values[9])), reason: values[10],
        actor_kind: values[11], actor_id: values[12], created_at: new Date('2025-03-22T10:00:00Z'),
      };
      this.decisions.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_id: values[2], payload: JSON.parse(String(values[3])) });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  release(): void { this.released = true; }
}

function dependencies(client: TransactionMock): FactDecisionDependencies {
  let next = 0;
  return { pool: { connect: async () => client }, newId: () => `generated-${++next}` };
}

test('selection is owner-first, identity-bound and preserves the original candidate provenance', async () => {
  const client = new TransactionMock();
  const selected = await appendFactDecision(dependencies(client), context, makeDecision({ selectedCandidateId: 'candidate-user' }));

  const lookup = client.calls.find((call) => call.sql.includes('FROM bb_fact_candidates'))!;
  assert.match(lookup.sql, /WHERE owner_user_id = \$1 AND project_id = \$2 AND id = \$3/);
  assert.deepEqual(lookup.values, ['owner-a', 'project-a', 'candidate-user']);
  assert.equal(selected.version, 1);
  assert.equal(selected.selectedCandidateProvenance?.source_kind, 'user_statement');
  assert.equal(selected.selectedCandidateProvenance?.status, 'user_asserted');
  assert.equal(selected.selectedCandidateProvenance?.source_ref, 'chat-1');
  assert.equal(client.candidates[1]!.status, 'user_asserted');
  assert.equal(client.decisions.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(client.outbox[0]!.aggregate_id, 'decision-1');
  assert.equal(client.released, true);
  assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
});

test('rejects a wrong-owner candidate without revealing its existence and rejects an identity mismatch', async () => {
  const foreign = new TransactionMock();
  foreign.candidates.push({ ...foreign.candidates[0]!, id: 'foreign-candidate', owner_user_id: 'owner-b' });
  await assert.rejects(appendFactDecision(dependencies(foreign), context, makeDecision({ selectedCandidateId: 'foreign-candidate' })),
    /FACT_CANDIDATE_NOT_FOUND/);
  assert.equal(foreign.decisions.length, 0);
  assert.equal(foreign.calls.at(-1)?.sql, 'ROLLBACK');

  const wrongKey = new TransactionMock();
  wrongKey.candidates.push({ ...wrongKey.candidates[0]!, id: 'wrong-key', fact_key: otherIdentity,
    fact_key_hash: factKeyHash(otherIdentity) });
  await assert.rejects(appendFactDecision(dependencies(wrongKey), context, makeDecision({ selectedCandidateId: 'wrong-key' })),
    /FACT_CANDIDATE_IDENTITY_MISMATCH/);
  assert.equal(wrongKey.decisions.length, 0);
  assert.equal(wrongKey.calls.at(-1)?.sql, 'ROLLBACK');
});

test('same request replays the same decision and does not add another version or outbox event', async () => {
  const client = new TransactionMock();
  const deps = dependencies(client);
  const first = await appendFactDecision(deps, context, makeDecision());
  const replay = await appendFactDecision(deps, context, makeDecision());
  assert.equal(first.version, 1);
  assert.equal(replay.version, 1);
  assert.equal(replay.replayed, true);
  assert.equal(client.decisions.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(client.calls.some((call) => call.sql.startsWith('INSERT INTO bb_fact_decisions') && call !== client.calls[0]), true);
  await assert.rejects(appendFactDecision(deps, context, makeDecision({ reason: 'changed reason' })),
    /FACT_DECISION_IDEMPOTENCY_MISMATCH/);
  assert.equal(client.decisions.length, 1);
  assert.equal(client.outbox.length, 1);
});

test('replay compares canonical fact identity and validates malformed runtime values safely', async () => {
  const client = new TransactionMock();
  const deps = dependencies(client);
  const input = makeDecision();
  await appendFactDecision(deps, context, input);
  const reordered = Object.fromEntries(Object.entries(identity).reverse()) as unknown as FactIdentity;
  assert.equal((await appendFactDecision(deps, context, { ...input, identity: reordered })).replayed, true);
  await assert.rejects(appendFactDecision(deps, context, makeDecision({ identity: { ...identity, scope: 3 } as unknown as FactIdentity })),
    /INVALID_FACT_IDENTITY/);
  await assert.rejects(appendFactDecision(deps, context, makeDecision({ identity: { ...identity, currency: '' } })),
    /INVALID_FACT_IDENTITY/);
  await assert.rejects(appendFactDecision(deps, context, makeDecision({ identity: { ...identity, period: [] } as unknown as FactIdentity })),
    /INVALID_FACT_IDENTITY/);
  await assert.rejects(appendFactDecision(deps, context, makeDecision({ identity: { ...identity, period: { start: '2024-02-30' } } })),
    /INVALID_FACT_PERIOD/);
  await assert.rejects(appendFactDecision(deps, { ...context, actorKind: 'system' }, makeDecision()),
    /SYSTEM_CANNOT_SELECT_FACT/);
  assert.equal(client.decisions.length, 1);
});

test('unresolved decision is versioned and competing candidates remain intact', async () => {
  const client = new TransactionMock();
  const first = await appendFactDecision(dependencies(client), context, makeDecision({
    decisionId: 'decision-unresolved', requestId: 'request-unresolved', resolution: 'unresolved',
    selectedCandidateId: undefined, reason: '现有来源日期不足以确认采用版本',
  }));
  assert.equal(first.resolution, 'unresolved');
  assert.equal(first.selectedCandidateId, null);
  assert.equal(first.selectedCandidateProvenance, null);
  assert.equal(client.candidates.length, 2);
  assert.deepEqual(client.candidates.map((candidate) => candidate.id), ['candidate-a', 'candidate-user']);
  assert.equal(client.outbox[0]!.payload && (client.outbox[0]!.payload as Record<string, unknown>).resolution, 'unresolved');
});

test('latest decision reader is exact identity and owner/project scoped', async () => {
  const client = new TransactionMock(); const deps = dependencies(client);
  const first = await appendFactDecision(deps, context, makeDecision());
  const latest = await appendFactDecision(deps, context, makeDecision({ decisionId: 'decision-2', requestId: 'request-2', resolution: 'unresolved', selectedCandidateId: undefined }));
  assert.equal((await getLatestFactDecision(deps, context, identity))?.decisionId, latest.decisionId);
  assert.equal((await getLatestFactDecision(deps, context, otherIdentity)), null);
  const query = client.calls.find(call => call.sql.includes('ORDER BY version DESC LIMIT 1'))!;
  assert.match(query.sql, /WHERE owner_user_id = \$1 AND project_id = \$2 AND fact_key_hash = \$3/);
  assert.deepEqual(query.values, [context.ownerUserId, context.projectId, factKeyHash(identity)]);
  await assert.rejects(getLatestFactDecision(deps, { ...context, ownerUserId: 'other-owner' }, identity), /INVALID_FACT_DECISION_SCOPE/);
  assert.equal(first.version, 1);
});

test('decision and outbox roll back atomically if the outbox insert fails', async () => {
  const client = new TransactionMock();
  client.failOutbox = true;
  await assert.rejects(appendFactDecision(dependencies(client), context, makeDecision()), /synthetic outbox failure/);
  assert.equal(client.decisions.length, 0);
  assert.equal(client.outbox.length, 0);
  assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(client.released, true);
});

test('live PostgreSQL appends immutable, versioned decisions atomically and keeps owner/key candidates isolated', {
  skip: !testDatabaseUrl && 'set FACT_DECISION_TEST_DATABASE_URL for migrated PostgreSQL 16',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID();
  const owner = `decision-owner-${suffix}`;
  const project = `decision-project-${suffix}`;
  const upload = `decision-upload-${suffix}`;
  const materialId = `decision-material-${suffix}`;
  const foreignOwner = `decision-foreign-owner-${suffix}`;
  const foreignProject = `decision-foreign-project-${suffix}`;
  const foreignUpload = `decision-foreign-upload-${suffix}`;
  const foreignMaterialId = `decision-foreign-material-${suffix}`;
  const foreignHash = createHash('sha256').update(`foreign-${suffix}`).digest('hex');
  const sqlSuffix = suffix.replaceAll('-', '').slice(0, 16);
  const hash = createHash('sha256').update(suffix).digest('hex');
  const liveContext: TrustedFactDecisionContext = { ownerUserId: owner, projectId: project, actorId: `actor-${suffix}`, actorKind: 'user' };
  const liveIdentity: FactIdentity = { ...identity, accountId: owner };
  const liveEvidence: FactEvidenceAnchor[] = [{
    evidence_id: `evidence-${suffix}`, material_id: materialId, material_version: 1, content_hash: hash,
    locator_type: 'text_line', locator: { line: 1 }, literal_quote: '合成测试数据 123',
    extraction_method: 'native_text', extraction_version: 'test-1', confidence: 1, uncertainty: [],
  }];
  const liveCandidate: FactCandidate = {
    candidateId: `candidate-${suffix}`, identity: liveIdentity, value: { kind: 'known', decimalOrText: '123.00' },
    source: { kind: 'audited', sourceId: `synthetic-audit-${suffix}`, observedAt: '2025-03-20T10:00:00Z', validAsOf: '2024-12-31' },
    confidence: 1,
  };
  try {
    await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES ($1,$2,$3,$4)',
      [project, owner, 'Synthetic fact decision test', 'update']);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',$10)`,
    [upload, owner, project, 'synthetic.txt', 'text/plain', 10, hash, 'audit', `synthetic/${suffix}`, 'completed']);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES ($1,1,$2,$3,$4,'audit','synthetic.txt','text/plain',10,$5,$6,'parsed')`,
    [materialId, owner, project, upload, hash, `synthetic-material/${suffix}`]);
    await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES ($1,$2,$3,$4)',
      [foreignProject, foreignOwner, 'Synthetic foreign project', 'update']);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 hour',$10)`,
    [foreignUpload, foreignOwner, foreignProject, 'synthetic.txt', 'text/plain', 10, foreignHash, 'audit', `synthetic/${foreignOwner}`, 'completed']);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES ($1,1,$2,$3,$4,'audit','synthetic.txt','text/plain',10,$5,$6,'parsed')`,
    [foreignMaterialId, foreignOwner, foreignProject, foreignUpload, foreignHash, `synthetic-material/${foreignOwner}`]);

    // Since #134, candidates must cite persisted parse evidence, so seed one synthetic snapshot + record per material.
    const seedParseEvidence = async (seedOwner: string, seedProject: string, seedMaterial: string, seedHash: string) => {
      const snapshotId = `decision-snapshot-${seedMaterial}`;
      const anchor = liveEvidence[0]!;
      await pool.query(`INSERT INTO bb_parse_snapshots
        (id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,request_options,
         response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'{}'::jsonb,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [snapshotId, seedOwner, seedProject, seedMaterial, seedHash, anchor.extraction_version, 'b'.repeat(64), 'c'.repeat(64), JSON.stringify({
        schema_version: 'document-parse-response-v1', request_id: `decision-parse-${seedMaterial}`, parser_version: anchor.extraction_version,
        status: 'parsed', material: { material_id: seedMaterial, material_version: 1, media_type: 'text/plain', sha256: seedHash },
        warnings: [], document: { page_count: null }, error: null,
      })]);
      await pool.query(`INSERT INTO bb_parse_evidence
        (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,locator_type,locator,
         literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9,'synthetic context',$10,$11,$12,$13::jsonb,'{}'::jsonb,$14,0)`,
      [seedOwner, seedProject, seedMaterial, snapshotId, anchor.evidence_id, seedHash, anchor.locator_type, JSON.stringify(anchor.locator),
        anchor.literal_quote, anchor.extraction_method, anchor.extraction_version, anchor.confidence,
        JSON.stringify(anchor.uncertainty), 'd'.repeat(64)]);
    };
    await seedParseEvidence(owner, project, materialId, hash);
    await seedParseEvidence(foreignOwner, foreignProject, foreignMaterialId, foreignHash);

    const firstCandidate = await insertFactCandidate({ pool }, liveContext, liveCandidate,
      { id: materialId, version: 1 }, liveEvidence);
    const secondCandidate = await insertFactCandidate({ pool }, liveContext, {
      ...liveCandidate,
      candidateId: `candidate-second-${suffix}`,
      value: { kind: 'known', decimalOrText: '124.00' },
      source: { ...liveCandidate.source, sourceId: `synthetic-audit-second-${suffix}` },
    }, { id: materialId, version: 1 }, liveEvidence);
    const foreignContext: TrustedFactDecisionContext = { ownerUserId: foreignOwner, projectId: foreignProject,
      actorId: `actor-foreign-${suffix}`, actorKind: 'user' };
    const foreignCandidate = await insertFactCandidate({ pool }, foreignContext, {
      ...liveCandidate, candidateId: `candidate-foreign-${suffix}`, identity: { ...liveIdentity, accountId: foreignOwner },
      source: { ...liveCandidate.source, sourceId: `synthetic-foreign-${suffix}` },
    }, { id: foreignMaterialId, version: 1 }, [{ ...liveEvidence[0]!, material_id: foreignMaterialId, content_hash: foreignHash }]);

    const decisionDeps: FactDecisionDependencies = { pool, newId: () => `outbox-${randomUUID()}` };
    const firstInput = makeDecision({ decisionId: `decision-${suffix}`, requestId: `request-${suffix}`, identity: liveIdentity,
      selectedCandidateId: firstCandidate.candidate.candidateId, reason: '合成样本：选用第一个候选' });
    const firstDecision = await appendFactDecision(decisionDeps, liveContext, firstInput);
    const replay = await appendFactDecision(decisionDeps, liveContext, firstInput);
    assert.equal(firstDecision.version, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.version, 1);
    const secondDecision = await appendFactDecision(decisionDeps, liveContext, makeDecision({
      decisionId: `decision-second-${suffix}`, requestId: `request-second-${suffix}`, identity: liveIdentity,
      selectedCandidateId: secondCandidate.candidate.candidateId, reason: '合成样本：后续改选第二个候选',
    }));
    assert.equal(secondDecision.version, 2);
    const latestRead = await getLatestFactDecision(decisionDeps, liveContext, liveIdentity);
    assert.equal(latestRead?.decisionId, secondDecision.decisionId);
    assert.equal(latestRead?.version, 2);
    assert.equal(await getLatestFactDecision(decisionDeps, liveContext, { ...liveIdentity, scope: 'parent_company' }), null);

    await assert.rejects(appendFactDecision(decisionDeps, liveContext, makeDecision({
      decisionId: `decision-wrong-owner-${suffix}`, requestId: `request-wrong-owner-${suffix}`, identity: liveIdentity,
      selectedCandidateId: foreignCandidate.candidate.candidateId, reason: 'wrong owner',
    })), /FACT_CANDIDATE_NOT_FOUND/);
    const wrongKeyIdentity: FactIdentity = { ...liveIdentity, scope: 'parent_company' };
    const wrongKey = await insertFactCandidate({ pool }, liveContext,
      { ...liveCandidate, candidateId: `candidate-other-key-${suffix}`, identity: wrongKeyIdentity },
      { id: materialId, version: 1 }, liveEvidence);
    await assert.rejects(appendFactDecision(decisionDeps, liveContext, makeDecision({
      decisionId: `decision-wrong-key-${suffix}`, requestId: `request-wrong-key-${suffix}`, identity: liveIdentity,
      selectedCandidateId: wrongKey.candidate.candidateId, reason: 'wrong identity',
    })), /FACT_CANDIDATE_IDENTITY_MISMATCH/);

    const beforeFailure = await pool.query('SELECT count(*)::int AS count FROM bb_fact_decisions WHERE owner_user_id=$1 AND project_id=$2',
      [owner, project]);
    await pool.query(`CREATE FUNCTION bb_test_fail_fact_decision_outbox_${sqlSuffix}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='fact.decision.appended' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER bb_test_fail_fact_decision_outbox_${sqlSuffix} BEFORE INSERT ON bb_outbox
      FOR EACH ROW EXECUTE FUNCTION bb_test_fail_fact_decision_outbox_${sqlSuffix}()`);
    try {
      await assert.rejects(appendFactDecision(decisionDeps, liveContext, makeDecision({
        decisionId: `decision-rollback-${suffix}`, requestId: `request-rollback-${suffix}`, identity: liveIdentity,
        selectedCandidateId: firstCandidate.candidate.candidateId, reason: 'outbox rollback',
      })), /synthetic outbox failure/);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS bb_test_fail_fact_decision_outbox_${sqlSuffix} ON bb_outbox`);
      await pool.query(`DROP FUNCTION IF EXISTS bb_test_fail_fact_decision_outbox_${sqlSuffix}()`);
    }
    const afterFailure = await pool.query('SELECT count(*)::int AS count FROM bb_fact_decisions WHERE owner_user_id=$1 AND project_id=$2',
      [owner, project]);
    assert.equal(afterFailure.rows[0]!.count, beforeFailure.rows[0]!.count);

    const unchanged = await pool.query('SELECT id,status,value_decimal FROM bb_fact_candidates WHERE owner_user_id=$1 AND project_id=$2 ORDER BY id',
      [owner, project]);
    assert.deepEqual(unchanged.rows.map((row) => [row.id, row.status, row.value_decimal]), [
      [firstCandidate.candidate.candidateId, 'extracted', '123.00'],
      [secondCandidate.candidate.candidateId, 'extracted', '124.00'],
      [wrongKey.candidate.candidateId, 'extracted', '123.00'],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    await assert.rejects(pool.query('UPDATE bb_fact_candidates SET value_decimal=$1 WHERE id=$2', ['999.00', firstCandidate.candidate.candidateId]),
      /fact candidate is referenced/);
    await assert.rejects(pool.query('DELETE FROM bb_fact_candidates WHERE id=$1', [firstCandidate.candidate.candidateId]),
      /fact candidate is referenced/);
    await assert.rejects(pool.query('UPDATE bb_fact_decisions SET reason=$1 WHERE id=$2', ['tampered', firstDecision.decisionId]),
      /fact decisions are append-only/);
    await assert.rejects(pool.query('DELETE FROM bb_fact_decisions WHERE id=$1', [firstDecision.decisionId]),
      /fact decisions are append-only/);
    const outboxCount = await pool.query(`SELECT count(*)::int AS count FROM bb_outbox WHERE owner_user_id=$1 AND event_type='fact.decision.appended'`, [owner]);
    assert.equal(outboxCount.rows[0]!.count, 2);
  } finally {
    await pool.end();
  }
});
