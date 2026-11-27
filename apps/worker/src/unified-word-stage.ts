import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest } from '@bondbuddy/api/data';
import type { UnifiedPlan } from './unified-model-stage.js';
import type { RunStage } from './run-pipeline.js';
import { executableRevisionFinding, ReviewRevisionHandlingSchema } from '@bondbuddy/contracts';
import { Value } from '@sinclair/typebox/value';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { resolvePythonExecutable } from './python-executable.js';

const runFile = promisify(execFile);
const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
export function unifiedWordDeliveryStage(): RunStage {
  return { name: 'word_delivery', replay: true, run: async ctx => {
    const plan = ctx.values.get('model_generation') as UnifiedPlan;
    if (!plan || plan.version !== 'unified-plan-v1' || plan.input_hash !== ctx.run.input_hash.trim() || plan.calls < 1)
      return { kind: 'fail', code: 'VALIDATION_FAILED' };
    const revision = plan.input.manifest.authoring.review_revision;
    const allowed = revision ? new Set(revision.selected_findings.filter(executableRevisionFinding)
      .flatMap(finding => finding.repairability.allowed_record_ids.map(id => `${revision.source_material.material_id}/${id}`))) : null;
    if (revision && (!plan.source || !plan.revision_handling || !Value.Check(ReviewRevisionHandlingSchema,plan.revision_handling)
        || inputManifestHash(plan.revision_handling.source_report) !== inputManifestHash(revision.source_report)
        || inputManifestHash(plan.revision_handling.accepted_plan) !== inputManifestHash(revision.accepted_plan)
        || inputManifestHash(plan.revision_handling.source_material) !== inputManifestHash(revision.source_material)
        || plan.source.pin.material_id !== revision.source_material.material_id || plan.source.pin.material_version !== revision.source_material.material_version
        || plan.source.pin.sha256 !== revision.source_material.sha256 || plan.blocks.length > 0
        || !plan.edits.length && !plan.additions.length
        || plan.edits.some(edit => !allowed!.has(edit.record_id)) || plan.additions.some(addition => !allowed!.has(addition.after_record_id))))
      return { kind:'fail',code:'INPUT_REVISION_CONFLICT' };
    const gate = await ctx.validateBeforeModelCall?.();
    if (gate) return gate;
    const date = (await ctx.pool.query('SELECT created_at FROM bb_runs WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [ctx.run.id, ctx.run.owner_user_id, ctx.run.project_id])).rows[0]?.created_at;
    if (!date) return { kind: 'fail', code: 'NOT_FOUND' };
    const directory = await mkdtemp(resolve(tmpdir(), 'bb-unified-word-'));
    try {
      const source = plan.source;
      if (source) {
        const bytes = await ctx.blobs.getIfExistsBounded(source.objectKey, 100 * 1024 * 1024);
        if (!bytes || digest(bytes) !== source.pin.sha256) return { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
        await writeFile(resolve(directory, 'source'), bytes, { mode: 0o600 });
      }
      const planHash = digest(JSON.stringify({ edits: plan.edits, blocks: plan.blocks, additions: plan.additions }));
      const request = { version: 'unified-word-request-v1', date: new Date(date).toISOString(),
        source_sha256: source?.pin.sha256 ?? null, media_type: source?.mediaType ?? null,
        records: source?.records.map(r => ({ id: `${source.pin.material_id}/${r.record_id}`, text: r.literal_quote, locator: r.locator })) ?? [],
        edits: plan.edits, blocks: plan.blocks, additions: plan.additions, plan_hash: planHash,
        ...(revision ? {revision_handling:plan.revision_handling,revision_allowed_record_ids:[...allowed!]} : {}) };
      await writeFile(resolve(directory, 'request.json'), JSON.stringify(request), { mode: 0o600 });
      const paths = ['tracked.docx', 'clean.docx', 'baseline.docx'].map(file => resolve(directory, file));
      const result = await runFile(resolvePythonExecutable(),
        ['-m', 'bondbuddy_word_delivery.unified', resolve(directory, 'request.json'), source ? resolve(directory, 'source') : '-', ...paths],
        { cwd: repo, env: { ...process.env, PYTHONPATH: resolve(repo, 'python') }, timeout: 300000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal });
      const summary = JSON.parse(result.stdout.trim());
      const [bytes, cleanBytes, baselineBytes] = await Promise.all(paths.map(path => readFile(path)));
      if (summary.writer_version !== 'bondbuddy-unified-word-1.0.0' || summary.plan_hash !== planHash ||
        summary.source_sha256 !== (source?.pin.sha256 ?? null) || summary.revision_sha256 !== digest(bytes) ||
        summary.clean_sha256 !== digest(cleanBytes) || summary.effective_baseline_sha256 !== digest(baselineBytes))
        return { kind: 'fail', code: 'WORD_QUALITY_REJECTED' };
      return { kind: 'deliver', bytes, cleanBytes, baselineBytes,
        wordSummary: { ...summary, ...(source?.pin.role === 'project_output' ? {baseline_kind:'project_output'} : {}), authoring_summary: plan.summary,
          source_issuer: revision || source?.pin.role === 'project_output' ? plan.input.manifest.issuer_name : source ? plan.input.manifest.authoring.source_prospectuses.find(s => s.material_id === source.pin.material_id)?.issuer_name : null,
          ...(revision ? {revision_handling:plan.revision_handling,review_passed:false} : {}) } };
    } catch (error) {
      if (ctx.signal.aborted) return { kind: 'stopped' };
      if (error && typeof error === 'object' && 'stderr' in error && /^WORD_[A-Z_]+\s*$/.test(String(error.stderr))) return { kind: 'fail', code: 'WORD_QUALITY_REJECTED' };
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  } };
}
