// Synthetic CLI and financial facts; real contained process, MCP and host-written receipts.
// This verifies the engineering boundary, not provider or professional acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { DEFAULT_DISABLED_FEATURES, runContainedModelCall, type CodexAdapterConfig, type ContainedCallInput } from './codex-adapter.js';
import { MemoryCodexJournal } from './codex-memory-journal.js';
import { assembleCliReview, buildCliReviewPrompt, CliReviewSchema, normalizeCliReviewCitations, type CliReview, type ReviewAnalysisInput, type ReviewAnalysisRecord } from './review-model-stage.js';
import { loadReviewAuditKnowledge } from './review-knowledge.js';
import { reviewPromptRecordId } from './review-record-context.js';
import { isReviewModelEnvelope, reviewToolDataHash, type ReviewToolData } from './review-tools.js';

const fake = fileURLToPath(new URL('../test-fixtures/codex/review-pipeline.mjs', import.meta.url));

test('synthetic CLI calls the real review MCP, persists source-bound receipts and reuses only an intact matching envelope', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bb-m3-contained-'));
  const marker = join(directory, 'calls.jsonl');
  const records: ReviewAnalysisRecord[] = [
    { source_kind: 'disclosure', material_id: 'source', material_sha256: 'a'.repeat(64), value: '100.00' },
    { source_kind: 'audit', material_id: 'audit', material_sha256: 'b'.repeat(64), value: '120.00' },
  ].map(({ source_kind, material_id, material_sha256, value }) => {
    const literal_quote = `合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入${value}。`;
    return { owner_user_id: 'owner', project_id: 'project', material_id, material_version: 1, material_sha256,
      parse_snapshot_id: `snapshot-${material_id}`, parse_response_sha256: inputManifestHash({ material_id }), record_id: 'p1',
      record_sha256: inputManifestHash({ literal_quote }), locator_type: 'docx_block', locator: { stable_ref: 'p1', path: [{ paragraph: 1 }] }, literal_quote,
      extraction_method: 'native_text', uncertainty: [], source_kind: source_kind as ReviewAnalysisRecord['source_kind'] };
  });
  const input: ReviewAnalysisInput = { input_hash: 'c'.repeat(64), evidence: { owner_user_id: 'owner', project_id: 'project', report_id: 'report',
    source_material: { material_id: 'source', material_version: 1, sha256: 'a'.repeat(64) }, records, rules: [] },
    rule_context: null, rule_packs: [], formatting_requirements: [], requirements: ['合成工程验证：只复核金额。'],
    scope: { mode: 'full_review', finding_ids: [] }, report_version: 1, created_at: '2026-10-02T08:00:00Z', limitations: [] };
  const data: ReviewToolData = { input, knowledge: await loadReviewAuditKnowledge(), allowed_target_ids: [reviewPromptRecordId(records[0]!)] };
  const config: CodexAdapterConfig = { command: [process.execPath, fake, `--m3-marker=${marker}`], model_id: 'deepseek-flash', model_provider: 'deepseek',
    base_url: 'https://api.deepseek.com', wire_api: 'responses', model_config_version: 'synthetic-m3-contained', reasoning_effort: null,
    credential: { kind: 'env', name: 'BB_SYNTHETIC_M3_KEY' }, work_root: join(directory, 'work'), timeout_ms: 10000, kill_grace_ms: 200,
    max_output_bytes: 1024 * 1024, max_schema_reasks: 0, disabled_features: DEFAULT_DISABLED_FEATURES, path_env: process.env.PATH ?? '' };
  let normalizations = 0;
  const call: ContainedCallInput = { owner_user_id: 'owner', project_id: 'project', job_id: 'job', run_id: 'run', trace_id: 'run', logical_call_id: 'review',
    prompt_snapshot_ref: 'prompt', prompt: buildCliReviewPrompt(input, [], reviewToolDataHash(data)), reviewTools: data,
    result_schema_version: 'review-cli-v2', output: { kind: 'json', schema: CliReviewSchema, validate: value => Value.Check(CliReviewSchema, value),
      normalize: (value, context) => {
        normalizations++; assert(context.reviewToolTrace?.knowledge_read_complete);
        assert.deepEqual(new Set(context.reviewToolTrace.read_record_ids), new Set(records.map(reviewPromptRecordId)));
        return normalizeCliReviewCitations(input, value, context.reviewToolTrace);
      } } };
  const journal = new MemoryCodexJournal();
  try {
    const result = await runContainedModelCall(call, journal, config);
    assert.equal(result.status, 'completed', result.error_code ?? undefined);
    assert.equal(normalizations, 1);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]!.usage.status, 'measured');
    assert(result.attempts[0]!.tool_attempts >= 5, 'CLI really listed, read evidence and knowledge, and selected a calculation tool');
    assert(result.reviewToolTrace?.knowledge_read_complete);
    assert.deepEqual(new Set(result.reviewToolTrace.read_record_ids), new Set(records.map(reviewPromptRecordId)));
    assert.equal(result.reviewToolTrace.receipts.length, 1);
    const assembled = assembleCliReview(input, result.value as CliReview, data, result.reviewToolTrace);
    const finding = assembled.findings.find(f => f.calculation?.expected === '120.00')!;
    assert(finding, JSON.stringify(assembled.findings));
    assert.equal(finding.calculation?.observed, '100.00');
    assert.equal(finding.repairability.can_revise, true);
    assert.equal(finding.target_refs[0]!.material_id, 'source');
    assert.equal(finding.target_refs[0]!.parse_snapshot_id, 'snapshot-source');
    assert.equal(finding.evidence_refs[0]!.material_id, 'audit');
    assert.equal(assembled.coverage.filter(c => c.check_id.startsWith('audit-reconciliation:')).length, 0, 'no audit methods run unless CLI selects them');
    assert.equal(assembled.coverage.filter(c => c.check_id.startsWith('cli-method:') && c.outcome === 'uncovered').length, 40);
    const envelope: unknown = JSON.parse(journal.results.get(result.attempts[0]!.call_id)!.toString('utf8'));
    assert(isReviewModelEnvelope(envelope, data));
    const replayEvents = [...journal.events], beforeMarker = await readFile(marker, 'utf8');
    journal.prior = { call_id: result.attempts[0]!.call_id, attempt_no: 1, status: 'completed', observed: true };
    journal.readCompleted = async () => ({ value: envelope, result_sha256: result.attempts[0]!.result_sha256! });
    const replay = await runContainedModelCall(call, journal, config);
    assert.equal(replay.status, 'reused');
    assert.equal(normalizations, 1, 'accepted result replay needs no new normalization or model turn');
    assert.deepEqual(replay.value, result.value);
    assert.deepEqual(replay.reviewToolTrace, result.reviewToolTrace);
    assert.deepEqual(journal.events, replayEvents, 'replay does not send or charge for a second CLI turn');
    assert.equal(await readFile(marker, 'utf8'), beforeMarker);
    const modifiedData = structuredClone(data);
    modifiedData.input.requirements.push('different snapshot');
    const mismatched = await runContainedModelCall({ ...call, reviewTools: modifiedData }, journal, config);
    assert.equal(mismatched.status, 'needs_reconcile');
    assert.equal(mismatched.error_code, 'MODEL_PRIOR_ATTEMPT_UNRESOLVED');
    const forged = structuredClone(envelope);
    forged.tool_trace.receipts[0]!.evaluation.findings[0]!.calculation!.expected = '999.00';
    journal.readCompleted = async () => ({ value: forged, result_sha256: result.attempts[0]!.result_sha256! });
    assert.equal((await runContainedModelCall(call, journal, config)).status, 'needs_reconcile', 'stored receipts are recomputed instead of trusted by shape');
    assert.equal(await readFile(marker, 'utf8'), beforeMarker);
    assert.deepEqual(await readdir(config.work_root), [], 'attempt directories and their tool-data/trace files are removed');
    // A rejected real MCP turn retains only opt-in private evidence. It is not
    // placed in the accepted-result journal and cannot be replayed as completion.
    const rejectedJournal = new MemoryCodexJournal();
    assert.equal(call.output.kind, 'json');
    if (call.output.kind !== 'json') return;
    const rejected = await runContainedModelCall({ ...call, output: { ...call.output, normalize: (_value, context) => {
      assert(context.reviewToolTrace?.receipts.length); throw Error('Synthetic invalid citation');
    } } }, rejectedJournal, { ...config, retain_invalid_output: true });
    assert.equal(rejected.error_code, 'MODEL_OUTPUT_SCHEMA_INVALID'); assert.equal(rejectedJournal.results.size, 0);
    const capture = JSON.parse(await readFile(join(config.work_root, 'rejected-output', `${rejected.attempts[0]!.call_id}-attempt-1.json`), 'utf8'));
    assert.equal(capture.accepted, false); assert.equal(capture.category, 'normalizer');
    assert.equal(capture.input_pin.input_hash, input.input_hash); assert.deepEqual(capture.input_pin.source_material, input.evidence.source_material);
    const retainedTrace = JSON.parse(capture.review_tool_trace_json);
    assert(isReviewModelEnvelope({ version: 'review-model-envelope-v1', output: JSON.parse(capture.last_message), tool_trace: retainedTrace }, data));
    assert.equal(retainedTrace.receipts.length, 1);
    assert.equal(capture.version, 'codex-rejected-output-v1', 'diagnostics have no accepted result/envelope version');
  } finally {
    assert(directory.startsWith(join(tmpdir(), 'bb-m3-contained-')));
    await rm(directory, { recursive: true, force: true });
  }
});
