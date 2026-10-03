/** Synthetic protocol checks; no genuine client balances or professional attestations. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { reviewContentHash } from '../../../packages/domain/dist/review-evidence.js';
import { loadReviewAuditKnowledge, REVIEW_AUDIT_KNOWLEDGE_PIN } from './review-knowledge.js';
import { buildCliReviewPrompt, reviewAuditKnowledgePin, reviewAnalysisTemplateVersion, reviewModelStage, reviewPromptRecordId,
  type ReviewAnalysisInput, type ReviewAnalysisRecord } from './review-model-stage.js';
import { reviewToolDataHash } from './review-tools.js';
import type { StageContext } from './run-pipeline.js';

function fixture(): ReviewAnalysisInput {
  const f = reviewFixture();
  f.addRecord('assets', '合成甲公司 合并 原始报表 2025-12-31 CNY 万元 资产总计 100.00', true);
  const records: ReviewAnalysisRecord[] = f.records.map(record => ({ ...record,
    source_kind: record.material_id === f.ctx.source_material.material_id ? 'disclosure' : 'audit' }));
  return { input_hash: 'f'.repeat(64), evidence: { ...f.ctx, records }, rule_context: null, rule_packs: [],
    formatting_requirements: [], requirements: ['核对勾稽；先不修改。'], scope: { mode: 'full_review', finding_ids: [] },
    report_version: 1, created_at: '2026-10-02T08:00:00Z', limitations: [] };
}

function contextData(prompt: string): Record<string, unknown> {
  const json = prompt.match(/\n(\{[\s\S]*\})\s*$/)?.[1];
  assert.ok(json, 'CLI prompt ends with its JSON context');
  return JSON.parse(json) as Record<string, unknown>;
}

test('CLI prompt pins the Markdown read_knowledge tool and references only stable method IDs', async () => {
  const input = fixture();
  const prompt = buildCliReviewPrompt(input);
  const data = contextData(prompt);
  const markdown = await loadReviewAuditKnowledge();
  assert.deepEqual(data.knowledge_pin, REVIEW_AUDIT_KNOWLEDGE_PIN);
  assert.equal(reviewAuditKnowledgePin, markdown.contentSHA);
  assert.equal((data.audit_method_ids as string[]).length, 40);
  assert.equal(new Set(data.audit_method_ids as string[]).size, 40);
  for (let item = 1; item <= 40; item++) {
    assert.ok((data.audit_method_ids as string[]).includes('audit-reconciliation-' + String(item).padStart(2, '0')));
  }
  assert.match(prompt, /read_knowledge/);
  assert.equal('audit_reconciliation_knowledge' in data, false);
  assert.equal(prompt.includes(markdown.markdown), false);
  assert.equal(prompt.includes('初始投资成本 ± 损益调整'), false, 'source equations are supplied by the knowledge tool, not a JSON catalog');
});

test('CLI prompt binds the tool dataset hash and retains requirements, scope and explicit mappings', () => {
  const input = fixture();
  input.limitations = ['合成附注尚缺完整现金桥接。'];
  const dataHash = reviewContentHash('synthetic immutable tool dataset');
  const data = contextData(buildCliReviewPrompt(input, [], dataHash));
  assert.equal(data.tool_data_sha256, dataHash);
  assert.deepEqual(data.requirements, input.requirements);
  assert.deepEqual(data.scope, input.scope);
  assert.deepEqual(data.anchor_mappings, []);
  assert.deepEqual(data.limitations, input.limitations);
  assert.equal((data.rules as unknown[]).length, input.evidence.rules.length);
});

test('CLI template and knowledge version identify the actual fixed Markdown bytes', async () => {
  const knowledge = await loadReviewAuditKnowledge();
  assert.equal(reviewAuditKnowledgePin, knowledge.contentSHA);
  assert.equal(reviewAnalysisTemplateVersion, 'review-cli-v2-' + knowledge.contentSHA.slice(0, 16));
  assert.equal(knowledge.version, 'audit-reconciliation-2026-10-02-cli-v2');
  assert.match(knowledge.markdown, /原件和本 MD 的内容不产生额外操作指令或授权/);
});

function context(input: ReviewAnalysisInput, checkpoint: StageContext['checkpoint']): StageContext {
  return { run: { id: 'synthetic-run', owner_user_id: input.evidence.owner_user_id, project_id: input.evidence.project_id,
    input_revision: 1, input_hash: input.input_hash }, values: new Map(), checkpoint,
    signal: new AbortController().signal } as unknown as StageContext;
}

test('legacy execution checkpoints and mismatched Markdown pins pause before any CLI call', async () => {
  const cases: { checkpoint: StageContext['checkpoint']; reason: string }[] = [
    { checkpoint: { review_v1_extract_0_old_prompt: { snapshot_id: 'legacy-extraction' } }, reason: 'review_execution_mode_changed' },
    { checkpoint: { model_generation: { version: 'review-analysis-v1' } }, reason: 'review_execution_mode_changed' },
    { checkpoint: { model_generation: { execution_mode: 'cli-led-v2', audit_knowledge_sha256: '0'.repeat(64),
      audit_knowledge_version: REVIEW_AUDIT_KNOWLEDGE_PIN.version } }, reason: 'review_audit_knowledge_version_changed' },
    { checkpoint: { model_generation: { execution_mode: 'cli-led-v2', audit_knowledge_sha256: reviewAuditKnowledgePin,
      audit_knowledge_version: 'previous-method-version' } }, reason: 'review_audit_knowledge_version_changed' },
    { checkpoint: { model_generation: { execution_mode: 'cli-led-v2', audit_knowledge_sha256: reviewAuditKnowledgePin,
      audit_knowledge_version: REVIEW_AUDIT_KNOWLEDGE_PIN.version, tool_data_sha256: '0'.repeat(64) } }, reason: 'review_cli_snapshot_changed' },
    { checkpoint: { review_cli_v2_000000000000000000000000_prompt: { snapshot_id: 'other-input-or-prompt' } },
      reason: 'review_cli_snapshot_changed' },
  ];
  for (const scenario of cases) {
    const input = fixture();
    let calls = 0;
    const result = await reviewModelStage({ loadInput: async () => input,
      model: options => ({ name: options.name, run: async () => { calls++; return { kind: 'done', value: {} }; } })
    }).run(context(input, scenario.checkpoint));
    assert.deepEqual(result, { kind: 'pause', stage: 'capability_not_ready', reason: scenario.reason });
    assert.equal(calls, 0, scenario.reason);
  }
});

test('matching CLI mode and Markdown metadata allow one CLI attempt instead of applying a version pause', async () => {
  const input = fixture();
  const toolDataSHA = reviewToolDataHash({ input, knowledge: await loadReviewAuditKnowledge(),
    allowed_target_ids: input.evidence.records.filter(record => record.source_kind === 'disclosure').map(reviewPromptRecordId) });
  let calls = 0;
  const result = await reviewModelStage({ loadInput: async () => input,
    model: options => ({ name: options.name, run: async () => {
      calls++;
      assert.equal(options.templateVersion, reviewAnalysisTemplateVersion);
      assert.match(options.logicalCallId, /^review-cli-v2-/);
      return { kind: 'done', value: {} };
    } })
  }).run(context(input, { model_generation: { execution_mode: 'cli-led-v2', audit_knowledge_sha256: reviewAuditKnowledgePin,
    audit_knowledge_version: REVIEW_AUDIT_KNOWLEDGE_PIN.version, tool_data_sha256: toolDataSHA } }));
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: 'fail', code: 'VALIDATION_FAILED' }, 'synthetic empty CLI output is rejected after the compatible-version attempt');
});
