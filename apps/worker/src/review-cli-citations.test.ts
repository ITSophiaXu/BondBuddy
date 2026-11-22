// Synthetic source pins and host traces; no provider or business acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import {
  normalizeCliReviewCitations,
  reviewModelStage,
  reviewPromptRecordId,
  type CliReview,
  type ReviewAnalysisInput,
  type ReviewAnalysisRecord,
} from './review-model-stage.js';
import { loadReviewAuditKnowledge } from './review-knowledge.js';
import { syntheticCliReview } from './review-cli-test-fixtures.js';
import type { ReviewToolData } from './review-tools.js';
import type { StageContext } from './run-pipeline.js';

async function fixture(repeated = false) {
  const f = reviewFixture();
  f.observation('disclosure', '100.00');
  f.observation('audit', '1000.00', { source_kind: 'audit' });
  const records: ReviewAnalysisRecord[] = f.records.map((record, i) => ({
    ...record,
    record_id: repeated ? 'parser-repeated' : `parser-${i}`,
    source_kind: record.material_id === f.ctx.source_material.material_id ? 'disclosure' : 'audit',
  }));
  const input: ReviewAnalysisInput = {
    input_hash: 'f'.repeat(64),
    evidence: { ...f.ctx, records },
    rule_context: null,
    rule_packs: [],
    formatting_requirements: [],
    requirements: [],
    scope: { mode: 'full_review', finding_ids: [] },
    report_version: 1,
    created_at: '2026-10-04T08:00:00Z',
    limitations: [],
  };
  const data: ReviewToolData = {
    input,
    knowledge: await loadReviewAuditKnowledge(),
    allowed_target_ids: records
      .filter((r) => r.source_kind === 'disclosure')
      .map(reviewPromptRecordId),
  };
  const [target, evidence] = records;
  const output = syntheticCliReview(data, {
    concerns: [
      {
        stable_key: 'synthetic-concern',
        dimension: 'financial',
        conclusion: 'manual',
        severity: 'P2',
        title: 'Synthetic comparison',
        description: 'Synthetic manual comparison',
        target_refs: [{ record_id: target!.record_id, quote: target!.literal_quote }],
        evidence_refs: [{ record_id: evidence!.record_id, quote: evidence!.literal_quote }],
        rule_keys: [],
        suggested_change: null,
        limitations: [],
      },
    ],
    checks: [
      {
        check_id: 'synthetic-check',
        dimension: 'financial',
        outcome: 'manual',
        reason: 'Synthetic evidence retained for review',
        evidence_refs: [{ record_id: evidence!.record_id, quote: evidence!.literal_quote }],
        rule_keys: [],
        concern_keys: ['synthetic-concern'],
        receipt_id: null,
        receipt_check_id: null,
        resolves_finding_ids: [],
      },
    ],
  });
  return { input, data, target: target!, evidence: evidence!, ...output };
}

test('unique parser aliases normalize all citation fields using the actual host read trace and preserve original input', async () => {
  const f = await fixture(),
    original = structuredClone(f.output);
  const output = normalizeCliReviewCitations(f.input, f.output, f.tool_trace) as CliReview;
  assert.equal(output.concerns[0]!.target_refs[0]!.record_id, reviewPromptRecordId(f.target));
  assert.equal(output.concerns[0]!.evidence_refs[0]!.record_id, reviewPromptRecordId(f.evidence));
  assert.equal(output.checks[0]!.evidence_refs[0]!.record_id, reviewPromptRecordId(f.evidence));
  assert.deepEqual(f.output, original);
  assert.equal(output.concerns[0]!.target_refs[0]!.quote, f.target.literal_quote);
  assert.deepEqual(output.receipt_ids, original.receipt_ids);
});

test('repeated parser IDs across materials remain rejected even if their quoted values differ', async () => {
  const f = await fixture(true);
  assert.notEqual(f.target.literal_quote, f.evidence.literal_quote);
  assert.throws(
    () => normalizeCliReviewCitations(f.input, f.output, f.tool_trace),
    /alias_not_unique/,
  );
});

test('fabricated or noncontiguous quotes and a missing or wrong-input host trace cannot authorize aliases', async () => {
  const f = await fixture();
  const raw = structuredClone(f.output);
  raw.concerns[0]!.target_refs[0]!.quote = 'Fabricated or stitched quotation';
  assert.throws(
    () => normalizeCliReviewCitations(f.input, raw, f.tool_trace),
    /alias_invalid_quote/,
  );
  assert.throws(() => normalizeCliReviewCitations(f.input, f.output), /host_trace_missing/);
  assert.throws(
    () =>
      normalizeCliReviewCitations(f.input, f.output, {
        ...f.tool_trace,
        input_hash: '0'.repeat(64),
      }),
    /host_trace_missing/,
  );
});

test('aliases and qualified IDs cannot cite unread records or target another material or dimension', async () => {
  const f = await fixture();
  const unread = { ...f.tool_trace, read_record_ids: [reviewPromptRecordId(f.target)] };
  assert.throws(() => normalizeCliReviewCitations(f.input, f.output, unread), /unread_citation/);
  const qualified = structuredClone(f.output);
  qualified.concerns[0]!.evidence_refs[0]!.record_id = reviewPromptRecordId(f.evidence);
  assert.throws(() => normalizeCliReviewCitations(f.input, qualified, unread), /unread_citation/);
  const foreign = structuredClone(f.output);
  foreign.concerns[0]!.target_refs = [
    { record_id: f.evidence.record_id, quote: f.evidence.literal_quote },
  ];
  assert.throws(
    () => normalizeCliReviewCitations(f.input, foreign, f.tool_trace),
    /target_out_of_scope/,
  );
  assert.throws(
    () =>
      normalizeCliReviewCitations(
        f.input,
        f.output,
        f.tool_trace,
        new Set(f.data.allowed_target_ids),
        { financial: [], compliance: f.data.allowed_target_ids },
      ),
    /target_out_of_scope/,
  );
});

test('review stage exposes the host-trace normalizer to the model seam and preserves source-bound report references', async () => {
  const f = await fixture();
  const ctx = {
    run: {
      id: 'synthetic-run',
      owner_user_id: f.input.evidence.owner_user_id,
      project_id: f.input.evidence.project_id,
      input_revision: 1,
      input_hash: f.input.input_hash,
    },
    values: new Map(),
    checkpoint: {},
    signal: new AbortController().signal,
  } as unknown as StageContext;
  const stage = reviewModelStage({
    loadInput: async () => f.input,
    model: (options) => ({
      name: options.name,
      run: async () => {
        assert(options.normalize);
        const normalized = options.normalize(f.output, { reviewToolTrace: f.tool_trace });
        assert(options.validate(normalized));
        return { kind: 'done', value: { output: normalized, tool_trace: f.tool_trace } };
      },
    }),
  });
  const result = await stage.run(ctx);
  assert.equal(result.kind, 'done');
  if (result.kind !== 'done') return;
  const report = (
    result.value as {
      report: { findings: { target_refs: { record_id: string; material_id: string }[] }[] };
    }
  ).report;
  assert.equal(report.findings[0]!.target_refs[0]!.record_id, f.target.record_id);
  assert.equal(report.findings[0]!.target_refs[0]!.material_id, f.target.material_id);
});
