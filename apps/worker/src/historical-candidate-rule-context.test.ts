import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadHistoricalCandidateRuleGuidance } from './historical-candidate-rule-context.js';
import { loadSsePrivateCandidateAssets, SSE_PRIVATE_CANDIDATE_ASSET_PIN as pin,
  SSE_PRIVATE_CANDIDATE_RUNTIME_ROOT as root } from './sse-private-candidate-assets.js';

const target = { market: 'sse', offering: 'private', documentStage: 'issuance', asOf: '2026-09-27' } as const;
const expected = { taxonomyHash: pin.taxonomy.contentSha256, rulePackHash: pin.rulePack.contentSha256 };

test('exact research projection preserves every rule, source quote and coverage item within the prompt limit', async () => {
  const { bundle, pack } = await loadSsePrivateCandidateAssets(root);
  const g = await loadHistoricalCandidateRuleGuidance(target, expected);
  assert.equal(g.status, 'research_reference_only'); assert.equal(g.constitutes_compliance_result, false);
  assert.ok(!('release_event_id' in g));
  assert.deepEqual(g.rules.map(r => r.rule_id), pack.rules.map(r => r.rule_id));
  for (const rule of g.rules) {
    const original = pack.rules.find(r => r.rule_id === rule.rule_id)!;
    assert.equal(rule.enabled, false); assert.equal(rule.enforcement, 'research_only');
    assert.deepEqual(rule.boundaries, original.boundaries); assert.deepEqual(rule.exceptions, original.exceptions);
    assert.deepEqual(rule.applicability, original.applicability);
  }
  const ids = new Set(pack.rules.flatMap(r => r.source_ref_ids));
  assert.equal(g.sources.length, ids.size);
  for (const source of g.sources) {
    const original = pack.sources.find(s => s.source_id === source.source_id)!;
    assert.equal(source.exact_quote, original.exact_quote);
    assert.equal(source.clause_locator, original.clause_locator);
    assert.deepEqual(g.source_documents[source.document_ref], {
      kind: original.kind, authority: original.authority, document_title: original.document_title,
      source_version: original.source_version, document_hash: original.document_hash, official_url: original.official_url,
      published_on: original.published_on, effective_from: original.effective_from, effective_to: original.effective_to,
      verified_by: original.verified_by, verified_at: original.verified_at });
  }
  assert.deepEqual(g.coverage, bundle.coverage);
  assert.equal(g.coverage.items.filter(i => i.disposition === 'uncovered').length, 31);
  assert.equal(g.coverage.items.find(i => i.itemId === 'other-markets')?.disposition, 'not_applicable');
  assert.ok(g.coverage.items.every(i => i.ruleIds.length === 0));
  assert.ok(Buffer.byteLength(JSON.stringify(g)) < 180_000);
  assert.deepEqual(await loadHistoricalCandidateRuleGuidance(target, expected), g);
});

test('changed scope, dates and grant hashes do not load the candidate as a different release', async () => {
  for (const patch of [{ market: 'szse' }, { offering: 'public' }, { documentStage: 'unknown' }])
    await assert.rejects(loadHistoricalCandidateRuleGuidance({ ...target, ...patch } as typeof target, expected), /scope_not_installed/);
  for (const asOf of ['2026-06-31', '', '2026-9-27'])
    await assert.rejects(loadHistoricalCandidateRuleGuidance({ ...target, asOf }, expected), /date_required/);
  await assert.rejects(loadHistoricalCandidateRuleGuidance({ ...target, asOf: '2025-09-30' }, expected), /outside_candidate_window/);
  for (const key of ['taxonomyHash', 'rulePackHash'])
    await assert.rejects(loadHistoricalCandidateRuleGuidance(target, { ...expected, [key]: '0'.repeat(64) }), /pin_mismatch/);
});

test('packaged runtime works without repository or customer files and fails if a companion is changed', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'bb-candidate-package-'));
  try {
    const relative = 'knowledge/exchange-bonds/drafts/sse-private';
    await mkdir(join(isolated, relative), { recursive: true });
    for (const file of ['rule-pack.json', 'chapter-template.json', 'coverage.json'])
      await copyFile(join(root, relative, file), join(isolated, relative, file));
    const g = await loadHistoricalCandidateRuleGuidance(target, expected, isolated);
    assert.equal(g.pack_hash, pin.rulePack.contentSha256);
    await appendFile(join(isolated, relative, 'coverage.json'), ' ');
    await assert.rejects(loadHistoricalCandidateRuleGuidance(target, expected, isolated), { code: 'COVERAGE_BYTES_MISMATCH' });
    await rm(join(isolated, relative, 'chapter-template.json'));
    await assert.rejects(loadHistoricalCandidateRuleGuidance(target, expected, isolated), { code: 'CANDIDATE_ASSET_MISSING' });
  } finally { await rm(isolated, { recursive: true, force: true }); }
});
