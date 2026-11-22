import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { updateContentHash, type HistoricalUpdateInput } from '@bondbuddy/domain/historical-update';
import { factIdentityKey } from '@bondbuddy/domain/facts';
import {
  prepareHistoricalUpdate,
  historicalUpdateFactsHash,
  type LockedHistoricalUpdate,
  type HistoricalUpdateReaders,
} from './historical-update.js';
import type { StoredFactDecision } from './fact-decision-repository.js';
import type {
  ParseEvidenceDependencies,
  StoredParseSnapshot,
} from './parse-evidence-repository.js';
import type { StoredFactCandidate } from './fact-repository.js';
import type { StoredHistoricalProfile } from './historical-profile-repository.js';
import type { DocumentParseResponse } from './document-parser.js';

function setup(parsed?: DocumentParseResponse) {
  const input: HistoricalUpdateInput = JSON.parse(
    readFileSync(
      new URL('../../../tests/fixtures/historical-update/input.json', import.meta.url),
      'utf8',
    ),
  );
  const baseline = input.baseline;
  const response: DocumentParseResponse = parsed ?? {
    schema_version: 'document-parse-response-v1',
    request_id: 'synthetic-parse',
    parser_version: baseline.parserVersion,
    status: 'parsed',
    material: {
      material_id: baseline.materialId,
      material_version: 1,
      sha256: baseline.contentHash,
      media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    records: baseline.blocks.map((block) => ({
      record_id: block.recordId,
      material_id: baseline.materialId,
      material_version: 1,
      content_hash: baseline.contentHash,
      locator_type: block.locatorType,
      locator: block.locator,
      literal_quote: block.text,
      context: '',
      extraction_method: 'native_text',
      extractor_version: baseline.parserVersion,
      confidence: 1,
      uncertainty: [],
      formatting: block.formatting,
    })),
    warnings: [],
    document: { page_count: null, revision_summary: { insertions: 0, deletions: 0 } },
    error: null,
  };
  // Preserve semantic inventory by mapping stable native locations to this parser's record IDs.
  const idMap = new Map(
    baseline.blocks.map((block) => [
      block.recordId,
      response.records.find((record) => record.locator.stable_ref === block.locator.stable_ref)!
        .record_id,
    ]),
  );
  input.occurrences = input.occurrences.map((item) => ({
    ...item,
    recordId: idMap.get(item.recordId)!,
  }));
  input.columns = input.columns.map((column) => ({
    ...column,
    cells: column.cells.map((cell) => ({ ...cell, afterRecordId: idMap.get(cell.afterRecordId)! })),
  }));
  input.coverage = input.coverage.map((item) => ({ ...item, recordId: idMap.get(item.recordId)! }));
  const fields = [
    baseline.profile.source_market,
    baseline.profile.source_offering,
    baseline.profile.latest_reporting_cutoff,
    ...baseline.profile.reporting_periods,
  ];
  fields.forEach((field) => {
    field.provenance.extractor_version = `historical-native-recognition-v2/${response.parser_version}`;
    field.provenance.evidence_refs = field.provenance.evidence_refs.map((id) => idMap.get(id)!);
  });
  const { request_id: _request, ...stableResponse } = response;
  const snapshot: StoredParseSnapshot = {
    snapshotId: baseline.snapshotId,
    ownerUserId: baseline.ownerUserId,
    projectId: baseline.projectId,
    materialId: baseline.materialId,
    materialVersion: 1,
    contentSha256: response.material!.sha256,
    parserVersion: response.parser_version,
    requestId: response.request_id!,
    requestHash: 'f'.repeat(64),
    requestOptions: {},
    responseSha256: updateContentHash(stableResponse),
    response,
    evidence: response.records,
    createdAt: '2025-03-01T00:00:00Z',
    replayed: false,
  };
  const profile: StoredHistoricalProfile = {
    ownerUserId: baseline.ownerUserId,
    projectId: baseline.projectId,
    materialId: baseline.materialId,
    materialVersion: 1,
    profileVersion: 1,
    requestId: 'profile-request',
    writeKind: 'recognition',
    recognition: baseline.profile,
    actorId: null,
    correctionReason: null,
    correctionEvidenceRefs: [],
    createdAt: '2025-03-01T00:00:00Z',
    replayed: false,
  };
  const facts: StoredFactCandidate[] = input.facts.slice(0, 1).map((fact) => ({
    candidate: fact.candidate,
    provenance: {
      status: fact.status,
      uncertainty: [],
      materialId: 'audit-1',
      materialVersion: 1,
      sourceObservedAt: fact.candidate.source.observedAt,
      createdAt: '2025-03-01T00:00:00Z',
      evidence: fact.evidence.map((anchor) => ({
        evidence_id: anchor.recordId,
        material_id: anchor.materialId,
        material_version: anchor.materialVersion,
        content_hash: anchor.contentHash,
        locator_type: anchor.locatorType,
        locator: anchor.locator,
        literal_quote: anchor.literalQuote,
        extraction_method: 'native_text',
        extraction_version: anchor.extractionVersion,
        confidence: 1,
        uncertainty: [],
      })),
    },
  }));
  const identities = [
    ...new Map(
      input.bindings
        .flatMap((binding) => {
          const expr = binding.expression;
          return [
            ...(expr.kind === 'fact'
              ? [expr.identity]
              : expr.kind === 'sum'
                ? expr.terms
                : [expr.left, expr.right]),
            ...(binding.replaces ? [binding.replaces] : []),
          ];
        })
        .map((identity) => [factIdentityKey(identity), identity]),
    ).values(),
  ];
  const decisions = identities.map((identity) => ({
    identity,
    decision: null as StoredFactDecision | null,
  }));
  const locked: LockedHistoricalUpdate = {
    context: input.context,
    bindings: input.bindings,
    occurrences: input.occurrences,
    columns: input.columns,
    coverage: input.coverage,
    baseline: {
      materialId: baseline.materialId,
      materialVersion: 1,
      snapshotId: baseline.snapshotId,
      profileVersion: 1,
    },
    materials: [
      {
        materialId: baseline.materialId,
        materialVersion: 1,
        role: 'historical',
        contentHash: snapshot.contentSha256,
      },
      { materialId: 'audit-1', materialVersion: 1, role: 'audit', contentHash: 'b'.repeat(64) },
    ],
    factCandidateIds: facts.map((fact) => fact.candidate.candidateId),
    factsHash: historicalUpdateFactsHash(facts, decisions),
  };
  const rows = locked.materials.map((material) => ({
    owner_user_id: baseline.ownerUserId,
    project_id: baseline.projectId,
    id: material.materialId,
    version: material.materialVersion,
    sha256: material.contentHash,
    role: material.role,
  }));
  const queries: unknown[][] = [];
  const dependencies: ParseEvidenceDependencies = {
    pool: {
      async query(sql, values = []) {
        assert.match(sql, /owner_user_id=\$1 AND project_id=\$2/);
        assert.match(sql, /deleted_at IS NULL/);
        queries.push(values);
        return { rows: rows.filter((row) => row.id === values[2]) };
      },
      async connect() {
        throw new Error('test uses injected readers');
      },
    },
  };
  const readers: HistoricalUpdateReaders = {
    async snapshot(scope, id) {
      assert.equal(scope.ownerUserId, baseline.ownerUserId);
      assert.equal(id, baseline.snapshotId);
      return snapshot;
    },
    async profiles() {
      return [profile];
    },
    async facts(scope, identity) {
      assert.equal(scope.projectId, baseline.projectId);
      return facts.filter(
        (fact) => factIdentityKey(fact.candidate.identity) === factIdentityKey(identity),
      );
    },
    async decision(scope, identity) {
      assert.equal(scope.ownerUserId, baseline.ownerUserId);
      assert.equal(scope.projectId, baseline.projectId);
      return (
        decisions.find((item) => factIdentityKey(item.identity) === factIdentityKey(identity))
          ?.decision ?? null
      );
    },
  };
  return {
    input,
    locked,
    response,
    snapshot,
    profile,
    facts,
    decisions,
    rows,
    queries,
    dependencies,
    readers,
  };
}

test('composes immutable repositories, exact material/profile locks and audited facts into a deterministic plan', async () => {
  const s = setup();
  const before = structuredClone(s.locked);
  const first = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(first.status, 'planned');
  assert.equal(first.deliverable, false);
  assert.equal(first.textPreview[1]!.after, '2024年度营业收入为120.00万元。');
  assert.equal(first.replacements.length, 3);
  assert.equal(first.columns.length, 1);
  assert.ok(s.queries.every((values) => values[0] === 'owner-1' && values[1] === 'project-1'));
  assert.deepEqual(await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers), first);
  assert.deepEqual(s.locked, before);
});

test('locked interim financial external facts reach the deterministic planner and preserve source status', async () => {
  const s = setup();
  s.facts[0] = {
    ...s.facts[0]!,
    candidate: {
      ...s.facts[0]!.candidate,
      source: { ...s.facts[0]!.candidate.source, kind: 'external' },
    },
  };
  s.locked.materials = s.locked.materials.map((m) =>
    m.role === 'audit' ? { ...m, role: 'interimFinancial' } : m,
  );
  s.rows.find((r) => r.id === 'audit-1')!.role = 'interimFinancial';
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const before = structuredClone(s.facts);
  const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(plan.replacements.length, 3);
  assert.equal(plan.columns.length, 1);
  assert.ok(plan.findings.some((f) => f.code === 'UPDATE_NON_AUDIT_SOURCE_USED'));
  assert.deepEqual(s.facts, before);
});

for (const changed of [
  'owner',
  'project',
  'material_hash',
  'missing_material',
  'reference_role',
  'snapshot_owner',
  'snapshot_id',
  'response_hash',
  'evidence',
  'profile_version',
  'profile_parser',
  'candidate_missing',
  'fact_hash',
  'fact_material',
] as const) {
  test(`worker refuses ${changed} instead of reading latest or falling back to reference drafts`, async () => {
    const s = setup();
    if (changed === 'owner') s.rows[0]!.owner_user_id = 'other-owner';
    if (changed === 'project') s.rows[0]!.project_id = 'other-project';
    if (changed === 'material_hash') s.rows[0]!.sha256 = '9'.repeat(64);
    if (changed === 'missing_material') s.rows.splice(0, 1);
    if (changed === 'reference_role') s.rows[0]!.role = 'reference';
    if (changed === 'snapshot_owner') s.snapshot.ownerUserId = 'other-owner';
    if (changed === 'snapshot_id') s.snapshot.snapshotId = 'other-snapshot';
    if (changed === 'response_hash') s.snapshot.responseSha256 = '0'.repeat(64);
    if (changed === 'evidence') s.snapshot.evidence = [];
    if (changed === 'profile_version') s.profile.profileVersion = 2;
    if (changed === 'profile_parser')
      s.profile.recognition.source_market.provenance.extractor_version =
        'historical-native-recognition-v2/other-parser';
    if (changed === 'candidate_missing') s.facts.splice(0, 1);
    if (changed === 'fact_hash') s.locked.factsHash = '1'.repeat(64);
    if (changed === 'fact_material') {
      s.facts[0] = {
        ...s.facts[0]!,
        provenance: { ...s.facts[0]!.provenance, materialId: 'unlocked-audit' },
      };
      s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
    }
    await assert.rejects(prepareHistoricalUpdate(s.dependencies, s.locked, s.readers), /UPDATE_/);
  });
}

test('a new conflicting fact in the locked candidate set stays unresolved', async () => {
  const s = setup();
  s.facts.push({
    ...s.facts[0]!,
    candidate: {
      ...s.facts[0]!.candidate,
      candidateId: 'conflict',
      value: { kind: 'known', decimalOrText: '42' },
    },
  });
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  s.locked.factCandidateIds = s.facts.map((fact) => fact.candidate.candidateId);
  const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(plan.status, 'needs_confirmation');
  assert.equal(plan.replacements.length, 0);
  assert.ok(plan.findings.some((finding) => finding.code === 'UPDATE_FACT_MISSING'));
});

function decisionFor(candidate: StoredFactCandidate, projectId = 'project-1'): StoredFactDecision {
  return {
    decisionId: 'decision-1',
    requestId: 'request-1',
    ownerUserId: candidate.candidate.identity.accountId,
    projectId,
    factKeyHash: 'fixture-hash',
    identity: candidate.candidate.identity,
    version: 1,
    resolution: 'selected',
    selectedCandidateId: candidate.candidate.candidateId,
    selectedCandidateProvenance: {
      candidate_id: candidate.candidate.candidateId,
      source_kind: candidate.candidate.source.kind,
      source_ref: candidate.candidate.source.sourceId,
      status: candidate.provenance.status,
      source_observed_at: candidate.provenance.sourceObservedAt,
      source_valid_as_of: candidate.provenance.sourceValidAsOf ?? null,
      material_id: candidate.provenance.materialId,
      material_version: candidate.provenance.materialVersion,
    },
    reason: 'synthetic review',
    actorId: 'reviewer-1',
    actorKind: 'internal_reviewer',
    createdAt: '2025-03-01T00:00:00.000Z',
    replayed: false,
  };
}

test('a matching latest decision selects only the frozen candidate and its version changes the input hash', async () => {
  const s = setup();
  const conflict = {
    ...s.facts[0]!,
    candidate: {
      ...s.facts[0]!.candidate,
      candidateId: 'conflict',
      value: { kind: 'known' as const, decimalOrText: '42' },
    },
  };
  s.facts.push(conflict);
  s.locked.factCandidateIds = s.facts.map((item) => item.candidate.candidateId);
  s.decisions[0]!.decision = decisionFor(s.facts[0]!);
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(plan.replacements.length, 3);
  assert.ok(
    plan.replacements.every(
      (change) =>
        change.candidateIds.length === 1 &&
        change.candidateIds[0] === s.facts[0]!.candidate.candidateId,
    ),
  );
  const withoutDecision = structuredClone(s.decisions);
  withoutDecision[0]!.decision = null;
  const pendingLock = {
    ...s.locked,
    factsHash: historicalUpdateFactsHash(s.facts, withoutDecision),
  };
  const pending = await prepareHistoricalUpdate(s.dependencies, pendingLock, {
    ...s.readers,
    async decision() {
      return null;
    },
  });
  assert.equal(pending.status, 'needs_confirmation');
  assert.notEqual(plan.planningInputHash, pending.planningInputHash);
});

test('unresolved or non-frozen selections remain pending and foreign decisions are rejected', async () => {
  const s = setup();
  const conflict = {
    ...s.facts[0]!,
    candidate: {
      ...s.facts[0]!.candidate,
      candidateId: 'conflict',
      value: { kind: 'known' as const, decimalOrText: '42' },
    },
  };
  s.facts.push(conflict);
  s.locked.factCandidateIds = s.facts.map((item) => item.candidate.candidateId);
  const selected = decisionFor(s.facts[0]!);
  s.decisions[0]!.decision = {
    ...selected,
    resolution: 'unresolved',
    selectedCandidateId: null,
    selectedCandidateProvenance: null,
  };
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const unresolvedPlan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(unresolvedPlan.status, 'needs_confirmation');
  const noDecisionStates = structuredClone(s.decisions);
  noDecisionStates[0]!.decision = null;
  const noDecisionLock = {
    ...s.locked,
    factsHash: historicalUpdateFactsHash(s.facts, noDecisionStates),
  };
  const noDecisionPlan = await prepareHistoricalUpdate(s.dependencies, noDecisionLock, {
    ...s.readers,
    async decision() {
      return null;
    },
  });
  assert.notEqual(unresolvedPlan.planningInputHash, noDecisionPlan.planningInputHash);
  s.decisions[0]!.decision = { ...selected, selectedCandidateId: 'not-in-frozen-manifest' };
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  assert.equal(
    (await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers)).status,
    'needs_confirmation',
  );
  s.decisions[0]!.decision = { ...selected, ownerUserId: 'foreign-owner' };
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  await assert.rejects(
    prepareHistoricalUpdate(s.dependencies, s.locked, s.readers),
    /UPDATE_FACT_DECISION_SCOPE_MISMATCH/,
  );
});

test('a latest unresolved or stale selection keeps even a single candidate pending', async () => {
  const s = setup();
  const candidate = s.facts[0]!;
  const unresolved = decisionFor(candidate);
  s.decisions[0]!.decision = {
    ...unresolved,
    resolution: 'unresolved',
    selectedCandidateId: null,
    selectedCandidateProvenance: null,
  };
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const unresolvedPlan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(unresolvedPlan.status, 'needs_confirmation');
  assert.equal(unresolvedPlan.replacements.length, 0);
  s.decisions[0]!.decision = { ...unresolved, selectedCandidateId: 'stale-candidate-id' };
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const stalePlan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(stalePlan.status, 'needs_confirmation');
  assert.equal(stalePlan.replacements.length, 0);
});

test('invalid competing candidate provenance fails before a valid selection can filter it out', async () => {
  const s = setup();
  const selected = s.facts[0]!;
  s.facts.push({
    ...selected,
    candidate: { ...selected.candidate, candidateId: 'malformed-competitor' },
    provenance: { ...selected.provenance, materialId: 'outside-frozen-material' },
  });
  s.locked.factCandidateIds = s.facts.map((item) => item.candidate.candidateId);
  s.decisions[0]!.decision = decisionFor(selected);
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  await assert.rejects(
    prepareHistoricalUpdate(s.dependencies, s.locked, s.readers),
    /UPDATE_FACT_MATERIAL_MISMATCH/,
  );
});

test('even value-equal competing candidates require a selected decision', async () => {
  const s = setup();
  s.facts.push({
    ...s.facts[0]!,
    candidate: { ...s.facts[0]!.candidate, candidateId: 'same-value-candidate' },
  });
  s.locked.factCandidateIds = s.facts.map((item) => item.candidate.candidateId);
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(plan.status, 'needs_confirmation');
  assert.equal(plan.replacements.length, 0);
});

test('a selected user statement remains user_asserted and cannot become a usable fact', async () => {
  const s = setup();
  const original = s.facts[0]!;
  const userFact: StoredFactCandidate = {
    ...original,
    candidate: {
      ...original.candidate,
      source: {
        kind: 'user_statement',
        sourceId: 'statement-1',
        observedAt: '2025-03-01T00:00:00.000Z',
      },
    },
    provenance: { ...original.provenance, status: 'user_asserted' },
  };
  s.facts[0] = userFact;
  s.decisions[0]!.decision = decisionFor(userFact);
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(plan.status, 'needs_confirmation');
  assert.equal(plan.replacements.length, 0);
  assert.ok(plan.findings.some((finding) => finding.code === 'UPDATE_FACT_UNRESOLVED'));
});

test('a selected OCR-uncertain audited candidate is never promoted to verified', async () => {
  const s = setup();
  const original = s.facts[0]!;
  const ocrFact: StoredFactCandidate = {
    ...original,
    candidate: { ...original.candidate, uncertainty: 'OCR_REVIEW_REQUIRED' },
    provenance: { ...original.provenance, status: 'needs_confirmation' },
  };
  s.facts[0] = ocrFact;
  s.decisions[0]!.decision = decisionFor(ocrFact);
  s.locked.factsHash = historicalUpdateFactsHash(s.facts, s.decisions);
  const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  assert.equal(plan.status, 'needs_confirmation');
  assert.equal(plan.replacements.length, 0);
  assert.ok(plan.findings.some((finding) => finding.code === 'UPDATE_FACT_UNRESOLVED'));
});

test('facts added after execution snapshot do not mutate a locked plan on recovery', async () => {
  const s = setup();
  const original = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
  s.facts.push({
    ...s.facts[0]!,
    candidate: {
      ...s.facts[0]!.candidate,
      candidateId: 'later-candidate',
      value: { kind: 'known', decimalOrText: '1234' },
    },
  });
  assert.deepEqual(await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers), original);
});

for (const revisions of [false, true])
  test(
    `actual synthetic DOCX parser → locked repositories → update plan (old revisions=${revisions})`,
    {
      skip:
        !process.env.BONDBUDDY_TEST_PYTHON &&
        'Set BONDBUDDY_TEST_PYTHON to run the real Python parser component check.',
    },
    async () => {
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      const child = spawnSync(
        process.env.BONDBUDDY_TEST_PYTHON!,
        ['tests/fixtures/historical-update/parse_sample.py', ...(revisions ? ['--revisions'] : [])],
        {
          cwd: root,
          env: {
            ...process.env,
            PYTHONPATH: fileURLToPath(new URL('../../../python', import.meta.url)),
          },
          encoding: 'utf8',
        },
      );
      assert.equal(child.status, 0, child.stderr);
      const parsed: DocumentParseResponse = JSON.parse(child.stdout);
      const s = setup(parsed);
      const plan = await prepareHistoricalUpdate(s.dependencies, s.locked, s.readers);
      assert.equal(plan.deliverable, false);
      if (revisions) {
        assert.equal(plan.status, 'needs_confirmation');
        assert.equal(plan.replacements.length, 0);
        assert.equal(plan.source.priorRevisions.deletions, 1);
        assert.ok(plan.textPreview.every((block) => !block.before.includes('999999')));
        assert.ok(plan.findings.some((finding) => finding.code === 'UPDATE_BASELINE_UNCERTAIN'));
      } else {
        assert.equal(plan.status, 'planned');
        assert.equal(plan.replacements.length, 3);
        assert.deepEqual(
          plan.columns[0]!.cells.map((cell) => cell.after),
          ['2024年度', '120.00'],
        );
      }
    },
  );
