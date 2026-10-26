import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '@bondbuddy/api/data';
import { createRunSupplementFilePreparationFixture } from '../../api/dist/run-supplement-file-preparation-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { prepareRunSupplementReviewRequest } from './run-supplement-review-request.js';

const database = await isolatedTestDatabase(undefined, 'supplement-review-request');
async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-supplement-review-'));
  try { await visit(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

for (const operation of ['full_review', 'differential_review'] as const)
  test(`real paused ${operation} uses candidate source, saved report and exact scope without adoption or a call`, { skip: !database }, async () => {
    const fixture = await createRunSupplementFilePreparationFixture(database!, 'review', { operation });
    try {
      const before = await fixture.snapshot();
      const request = await prepareRunSupplementReviewRequest(fixture.preparationInput);
      const again = await prepareRunSupplementReviewRequest(fixture.preparationInput);
      assert.equal(request.preparation.planHash, again.preparation.planHash);
      assert.equal(request.preparation.priorWork.source.resultId, fixture.selected.result.id);
      assert.notEqual(request.preparation.sourceExecution.inputHash, request.preparation.candidateInputHash);
      await workspace(async cwd => {
        await request.prepare(cwd); await request.verifyOriginals(cwd);
        const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
        assert.equal(data.input_hash, fixture.preparationInput.expectedCandidateInputHash);
        assert.equal(data.scope.operation, operation);
        assert.equal(data.scope.source_report_id, fixture.manifest.review.source_report_id);
        assert.deepEqual(data.scope.selected_findings.map((finding: any) => finding.finding_id), fixture.manifest.review.finding_ids);
        assert.deepEqual(data.requirements, fixture.manifest.review.input.requirements);
        const source = data.materials.find((material: any) => material.review_source);
        assert.equal(source.material_id, fixture.replacement!.material_id);
        assert.equal(source.material_version, fixture.replacement!.material_version);
        assert.equal(source.sha256, fixture.replacement!.sha256);
        assert.deepEqual(data.continuation.delta, request.preparation.delta);
        assert.equal(data.continuation.previous_work.status, 'unverified_reference');
        for (const pin of request.preparation.priorWork.files)
          assert.deepEqual(await readFile(join(cwd, `previous_work/${pin.name}`)), fixture.fileBytes.get(pin.name));
        for (const material of data.materials) assert.deepEqual(await readFile(join(cwd, material.path)), fixture.objects.get(
          request.preparation.materials.find(item => item.pin.material_id === material.material_id)!.objectKey));
        assert.deepEqual(await readdir(join(cwd, 'output')), []);
        assert.match(await request.buildPrompt(), /所有拟保留的问题及核验结论都须按候选材料重新核实/);
      });
      assert.deepEqual(await fixture.snapshot(), before);
    } finally { await fixture.cleanup(); }
  });

test('M3 prepare rejects captured report loss, changed candidate material or changed pause checkpoint without writes', { skip: !database }, async () => {
  for (const target of ['report', 'material', 'checkpoint']) {
    const fixture = await createRunSupplementFilePreparationFixture(database!, 'review');
    try {
      const request = await prepareRunSupplementReviewRequest(fixture.preparationInput);
      if (target === 'report') fixture.objects.delete(request.preparation.priorWork.files.find(pin => pin.name === 'report.docx')!.key);
      if (target === 'material') fixture.objects.set(request.preparation.materials[0].objectKey, Buffer.from('changed material'));
      if (target === 'checkpoint') await fixture.pool.query("UPDATE bb_jobs SET checkpoint=checkpoint || '{\"synthetic_changed\":true}'::jsonb WHERE id=$1", [fixture.jobId]);
      const before = await fixture.snapshot();
      await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT/); });
      assert.deepEqual(await fixture.snapshot(), before);
    } finally { await fixture.cleanup(); }
  }
});

test('M3 before/after workspace checks reject a pause-boundary change during material I/O', { skip: !database }, async () => {
  const fixture = await createRunSupplementFilePreparationFixture(database!, 'review');
  try {
    let changed = false, afterChange: unknown;
    const blobs = { ...fixture.blobs, readToFile: async (key: string, path: string | null, max: number) => {
      const bytes = await fixture.blobs.getIfExistsBounded(key, max); if (!bytes) return null;
      if (path) await writeFile(path, bytes, { mode: 0o400 });
      if (!changed) {
        changed = true;
        await fixture.pool.query("UPDATE bb_jobs SET checkpoint=checkpoint || '{\"synthetic_during_prepare\":true}'::jsonb WHERE id=$1", [fixture.jobId]);
        afterChange = await fixture.snapshot();
      }
      return { sha256: digest(bytes), byteSize: bytes.length };
    } };
    const request = await prepareRunSupplementReviewRequest({ ...fixture.preparationInput, blobs });
    await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT/); });
    assert.equal(changed, true); assert.deepEqual(await fixture.snapshot(), afterChange);
  } finally { await fixture.cleanup(); }
});

test('caller mutations of returned M3 preparation cannot replace its pinned scope or input lock', { skip: !database }, async () => {
  const fixture = await createRunSupplementFilePreparationFixture(database!, 'review', { operation: 'differential_review' });
  try {
    const request = await prepareRunSupplementReviewRequest(fixture.preparationInput), before = await fixture.snapshot();
    request.preparation.candidateInputHash = '0'.repeat(64);
    request.preparation.manifest.review.finding_ids = ['caller-finding'];
    request.preparation.manifest.review.input.requirements = ['caller-scope'];
    await workspace(async cwd => {
      await request.prepare(cwd);
      const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
      assert.equal(data.input_hash, fixture.preparationInput.expectedCandidateInputHash);
      assert.deepEqual(data.requirements, fixture.manifest.review.input.requirements);
      assert.deepEqual(data.scope.selected_findings.map((finding: any) => finding.finding_id), fixture.manifest.review.finding_ids);
    });
    assert.deepEqual(await fixture.snapshot(), before);
  } finally { await fixture.cleanup(); }
});
