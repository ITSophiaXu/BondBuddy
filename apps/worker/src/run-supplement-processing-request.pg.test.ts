import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '@bondbuddy/api/data';
import { loadRunSupplementProcessingBasis, type RunSupplementProcessingKind } from '@bondbuddy/api/run-supplement-preparation';
import { createRunSupplementProcessingPlan } from '@bondbuddy/api/run-supplement-processing-plan';
import { createRunSupplementPreparationFixture } from '../../api/dist/run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from '../../api/dist/run-supplement-file-preparation-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { buildM4Method } from './m4-method.js';
import { prepareRunSupplementAuthoringRequest } from './run-supplement-authoring-request.js';
import { prepareRunSupplementReviewRequest } from './run-supplement-review-request.js';
import { prepareRunSupplementM4Request } from './run-supplement-m4-request.js';

const database = await isolatedTestDatabase(undefined, 'supplement-processing-request');
const config = loadCodexAdapterConfig({});
const method = await buildM4Method('document', loadM4RuntimeSkill('m4-underwriter'), config);
type EarlyPause = 'before_prompt' | 'after_prompt';

async function fixture(kind: RunSupplementProcessingKind, earlyPause?: EarlyPause) {
  if (kind === 'authoring') return earlyPause
    ? createRunSupplementPreparationFixture(database!, { earlyPause })
    : createRunSupplementPreparationFixture(database!);
  const options = { method, ...(kind === 'review' ? { operation: 'differential_review' as const } : {}) };
  return earlyPause ? createRunSupplementFilePreparationFixture(database!, kind, { ...options, earlyPause })
    : createRunSupplementFilePreparationFixture(database!, kind, options);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function state(f: Fixture) {
  return { original: await f.snapshot(),
    plans: (await f.pool.query('SELECT * FROM bb_run_supplement_processing_plans WHERE owner_user_id=$1 ORDER BY id', [f.owner])).rows,
    heads: (await f.pool.query('SELECT * FROM bb_run_execution_heads WHERE owner_user_id=$1 ORDER BY run_id', [f.owner])).rows };
}
async function persist(f: Fixture, kind: RunSupplementProcessingKind) {
  const basis = await loadRunSupplementProcessingBasis(f.preparationInput, kind);
  return createRunSupplementProcessingPlan({ ...f.preparationInput, kind, requestId: randomUUID(), expectedBasisHash: basis.basisHash });
}
function prepare(f: Fixture, kind: RunSupplementProcessingKind, planId: string, blobs = f.blobs) {
  const input = { ...f.preparationInput, blobs };
  if (kind === 'authoring') return prepareRunSupplementAuthoringRequest(input, { processingPlanId: planId });
  if (kind === 'review') return prepareRunSupplementReviewRequest(input, { processingPlanId: planId });
  return prepareRunSupplementM4Request(input, { processingPlanId: planId, config });
}
async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-processing-request-'));
  try { await visit(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
function checkScope(kind: RunSupplementProcessingKind, f: Fixture, data: any) {
  const manifest = f.manifest as any;
  assert.equal(data.input_hash, f.preparationInput.expectedCandidateInputHash);
  assert.notEqual(data.input_hash, f.hash);
  if (kind === 'authoring') {
    assert.equal(data.target.issuer_name, manifest.issuer_name);
    assert.equal(data.baseline_path, data.continuation ? 'previous_work/clean.docx' : null);
  } else if (kind === 'review') {
    assert.equal(data.scope.operation, 'differential_review');
    assert.equal(data.scope.source_report_id, manifest.review.source_report_id);
    assert.deepEqual(data.scope.selected_findings.map((finding: any) => finding.finding_id), manifest.review.finding_ids);
    assert.deepEqual(data.requirements, manifest.review.input.requirements);
    assert.equal(data.materials.find((material: any) => material.review_source).material_version, 2);
  } else {
    assert.deepEqual(data.task.input.source_material, manifest.input.source_material);
    assert.deepEqual(data.task.input.template, manifest.input.template);
    assert.deepEqual(data.task.input.edit_base, manifest.input.edit_base);
    assert.deepEqual(data.task.knowledge, manifest.knowledge);
    assert.equal(data.skill.sha256, method.skill_sha256);
  }
}

for (const kind of ['authoring', 'review', 'm4'] as const) {
  for (const earlyPause of ['before_prompt', 'after_prompt'] as const) {
    test(`${kind} durable ${earlyPause} plan writes the exact candidate without inventing old work or starting execution`,
      { skip: !database }, async () => {
        const f = await fixture(kind, earlyPause);
        try {
          const plan = await persist(f, kind), before = await state(f);
          const request = await prepare(f, kind, plan.id);
          assert.equal(request.preparation.priorWork, null);
          assert.equal(request.preparation.priorWorkStatus, 'no_prior_work');
          assert.equal(request.processingPlan?.id, plan.id);
          assert.equal(request.preparation.planHash, plan.planHash);
          assert.equal(Number((await f.pool.query('SELECT count(*)::int AS n FROM bb_model_call_attempts WHERE job_id=$1', [f.jobId])).rows[0].n), 0);
          await workspace(async cwd => {
            await request.prepare(cwd); await request.verifyOriginals(cwd);
            const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
            checkScope(kind, f, data);
            assert.equal(data.continuation, undefined);
            assert.equal((await readdir(cwd)).includes('previous_work'), false);
            assert.equal((await readdir(cwd)).includes('continuation.json'), false);
            assert.doesNotMatch(await request.buildPrompt(), /previous_work/);
            assert.deepEqual(await readdir(join(cwd, 'output')), []);
            assert.equal(data.materials.some((material: any) => material.material_id === f.added.material_id), true);
            for (const material of data.materials) {
              const expected = request.preparation.materials.find(item => item.pin.material_id === material.material_id)!;
              assert.deepEqual(await readFile(join(cwd, material.path)), f.objects.get(expected.objectKey));
            }
          });
          assert.deepEqual(await state(f), before, 'preparing a durable plan cannot queue, call, adopt, charge or change original records');
        } finally { await f.cleanup(); }
      });
  }

  test(`${kind} durable complete-work plan uses the actual continuation writer and immutable plan provenance`,
    { skip: !database }, async () => {
      const f = await fixture(kind);
      try {
        const plan = await persist(f, kind), before = await state(f), request = await prepare(f, kind, plan.id);
        assert.ok(request.preparation.priorWork);
        const expectedBasis = request.preparation.basisHash;
        // Public return values cannot retarget the privately captured writer.
        request.preparation.candidateInputHash = '0'.repeat(64);
        request.preparation.basisHash = '0'.repeat(64);
        if (request.processingPlan) request.processingPlan.planHash = '0'.repeat(64);
        await workspace(async cwd => {
          await request.prepare(cwd);
          const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
          checkScope(kind, f, data);
          assert.equal(data.continuation.version, 'run-supplement-processing-basis-v1');
          assert.equal(data.continuation.plan_hash, plan.planHash);
          assert.equal(data.continuation.basis_hash, expectedBasis);
          assert.equal(data.continuation.processing_plan_id, plan.id);
          for (const pin of request.preparation.priorWork!.files)
            assert.deepEqual(await readFile(join(cwd, 'previous_work', pin.name)), f.fileBytes.get(pin.name));
          assert.deepEqual(await readdir(join(cwd, 'output')), []);
        });
        assert.deepEqual(await state(f), before);
      } finally { await f.cleanup(); }
    });

  test(`${kind} durable early plan refuses a changed paused boundary during real material I/O`, { skip: !database }, async () => {
    const f = await fixture(kind, 'after_prompt');
    try {
      const plan = await persist(f, kind);
      let changed = false, expected: unknown;
      const blobs = { ...f.blobs, readToFile: async (key: string, path: string | null, max: number) => {
        const bytes = await f.blobs.getIfExistsBounded(key, max); if (!bytes) return null;
        if (path) await writeFile(path, bytes, { mode: 0o400 });
        if (!changed) {
          changed = true;
          await f.pool.query("UPDATE bb_jobs SET checkpoint=checkpoint || '{\"changed_during_plan_io\":true}'::jsonb WHERE id=$1", [f.jobId]);
          expected = await state(f);
        }
        return { sha256: digest(bytes), byteSize: bytes.length };
      } };
      const request = await prepare(f, kind, plan.id, blobs);
      await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT|计划/); });
      assert.equal(changed, true);
      assert.deepEqual(await state(f), expected);
    } finally { await f.cleanup(); }
  });

  test(`${kind} durable early plan cannot fall back after candidate material loss or a stale plan reference`, { skip: !database }, async () => {
    const f = await fixture(kind, 'before_prompt');
    try {
      const plan = await persist(f, kind), request = await prepare(f, kind, plan.id);
      const pin = request.preparation.materials.find(material => material.pin.material_id === f.added.material_id)!;
      f.objects.delete(pin.objectKey);
      const before = await state(f);
      await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT|计划/); });
      await assert.rejects(prepare(f, kind, randomUUID()), /INPUT_REVISION_CONFLICT|计划|不存在/);
      assert.deepEqual(await state(f), before);
    } finally { await f.cleanup(); }
  });
}

test('durable early M1 preserves the exact private requirements and ignores later project edits', { skip: !database }, async () => {
  const f = await createRunSupplementPreparationFixture(database!, { earlyPause: 'after_prompt', requirementBody: '准确原要求：核对新增材料。' });
  try {
    const plan = await persist(f, 'authoring');
    await f.saveLaterRequirement('后来草稿要求，不属于本次固定输入。');
    await f.pool.query('UPDATE bb_projects SET draft_revision=99 WHERE id=$1', [f.projectId]);
    const before = await state(f), request = await prepare(f, 'authoring', plan.id);
    await workspace(async cwd => {
      await request.prepare(cwd);
      const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
      assert.deepEqual(data.requirements, [f.requirement!.body]);
      assert.doesNotMatch(JSON.stringify(data), /后来草稿要求/);
    });
    assert.deepEqual(await state(f), before);
  } finally { await f.cleanup(); }
});

test('durable early M4 retains a saved method even before the first provider attempt', { skip: !database }, async () => {
  const f = await fixture('m4', 'after_prompt');
  try {
    const plan = await persist(f, 'm4'), before = await state(f);
    await assert.rejects(prepareRunSupplementM4Request(f.preparationInput,
      { processingPlanId: plan.id, config: { ...config, model_id: 'changed-before-first-attempt' } }), /m4_document_method_changed/);
    assert.deepEqual(await state(f), before);
  } finally { await f.cleanup(); }
});
