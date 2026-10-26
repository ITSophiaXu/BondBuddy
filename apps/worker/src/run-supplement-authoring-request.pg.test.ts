import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '@bondbuddy/api/data';
import { randomUUID } from 'node:crypto';
import { createRunSupplementPreparationFixture } from '../../api/dist/run-supplement-preparation-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { prepareRunSupplementAuthoringRequest } from './run-supplement-authoring-request.js';

const database = await isolatedTestDatabase(undefined, 'supplement-authoring-request');
async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-supplement-authoring-'));
  try { await visit(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('real paused saved receipt and candidate enter the production authoring writer without adopting or making a call',
  { skip: !database }, async () => {
    const fixture = await createRunSupplementPreparationFixture(database!, { wordBytes: makeWorkerDocxFixture({ externalLink: false }) });
    try {
      const before = await fixture.snapshot();
      const request = await prepareRunSupplementAuthoringRequest(fixture.preparationInput);
      const again = await prepareRunSupplementAuthoringRequest(fixture.preparationInput);
      assert.equal(request.preparation.planHash, again.preparation.planHash);
      assert.notEqual(request.preparation.sourceExecution.inputHash, fixture.preparationInput.expectedCandidateInputHash);
      assert.equal(request.preparation.delta.additions.length, 1);
      assert.equal(request.preparation.delta.replacements.length, 1);
      await workspace(async cwd => {
        await request.prepare(cwd); await request.verifyOriginals(cwd);
        const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
        assert.equal(data.input_hash, fixture.preparationInput.expectedCandidateInputHash);
        assert.equal(data.baseline_path, 'previous_work/clean.docx');
        assert.equal(data.baseline_kind, 'saved_clean_work');
        assert.deepEqual(data.continuation.delta, request.preparation.delta);
        assert.equal(data.continuation.source_execution.inputHash, request.preparation.sourceExecution.inputHash);
        const oldClean = request.preparation.priorWork.files.find(file => file.name === 'clean.docx')!;
        assert.deepEqual(await readFile(join(cwd, 'previous_work/clean.docx')), fixture.fileBytes.get(oldClean.name));
        assert.deepEqual(await readdir(join(cwd, 'output')), []);
        assert.match(await request.buildPrompt(), /结合材料新增、替换及原稿声明变化进行新的处理/);
        assert.match(await request.buildPrompt(), /保守复核全文/);
        assert.doesNotMatch(await request.buildPrompt(), /输入锁：\s*$/);
        for (const material of data.materials) assert.deepEqual(await readFile(join(cwd, material.path)), fixture.objects.get(request.preparation.materials.find(item => item.pin.material_id === material.material_id)!.objectKey));
      });
      assert.deepEqual(await fixture.snapshot(), before);
    } finally { await fixture.cleanup(); }
  });

test('private files or materials lost after initial loading reject prepare with unchanged calls, receipt and billing',
  { skip: !database }, async () => {
    for (const kind of ['old_file', 'material', 'checkpoint'] as const) {
      const fixture = await createRunSupplementPreparationFixture(database!, { wordBytes: makeWorkerDocxFixture({ externalLink: false }) });
      try {
        const request = await prepareRunSupplementAuthoringRequest(fixture.preparationInput);
        if (kind === 'old_file') fixture.objects.delete(request.preparation.priorWork.files.find(file => file.name === 'clean.docx')!.key);
        if (kind === 'material') fixture.objects.set(request.preparation.materials[0].objectKey, Buffer.from('corrupted material'));
        if (kind === 'checkpoint') await fixture.pool.query("UPDATE bb_jobs SET checkpoint=checkpoint || '{\"synthetic_changed\":true}'::jsonb WHERE id=$1", [fixture.jobId]);
        const before = await fixture.snapshot();
        await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT/); });
        assert.deepEqual(await fixture.snapshot(), before);
      } finally { await fixture.cleanup(); }
    }
  });

test('mutating returned preparation metadata cannot change the private request or turn it into an adopted input',
  { skip: !database }, async () => {
    const fixture = await createRunSupplementPreparationFixture(database!);
    try {
      const request = await prepareRunSupplementAuthoringRequest(fixture.preparationInput);
      const hash = request.preparation.candidateInputHash;
      request.preparation.manifest.issuer_name = 'caller mutation';
      request.preparation.candidateInputHash = '0'.repeat(64);
      request.preparation.delta.discardPreviousOutput = true;
      await workspace(async cwd => {
        await request.prepare(cwd);
        const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
        assert.equal(data.input_hash, hash);
        assert.notEqual(data.target.issuer_name, 'caller mutation');
        assert.equal(data.baseline_path, 'previous_work/clean.docx');
      });
    } finally { await fixture.cleanup(); }
  });

test('a pause-boundary change during actual workspace I/O is rejected before preparation returns',
  { skip: !database }, async () => {
    const fixture = await createRunSupplementPreparationFixture(database!);
    try {
      let changed = false, afterChange: unknown;
      const blobs = { ...fixture.blobs, readToFile: async (key: string, path: string | null, max: number) => {
        const bytes = await fixture.blobs.getIfExistsBounded(key, max);
        if (!bytes) return null;
        if (path) await writeFile(path, bytes, { mode: 0o400 });
        if (!changed) {
          changed = true;
          await fixture.pool.query("UPDATE bb_jobs SET checkpoint=checkpoint || '{\"synthetic_during_prepare\":true}'::jsonb WHERE id=$1", [fixture.jobId]);
          afterChange = await fixture.snapshot();
        }
        return { sha256: digest(bytes), byteSize: bytes.length };
      } };
      const request = await prepareRunSupplementAuthoringRequest({ ...fixture.preparationInput, blobs });
      await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT/); });
      assert.equal(changed, true);
      assert.deepEqual(await fixture.snapshot(), afterChange);
    } finally { await fixture.cleanup(); }
  });

test('the actual pinned requirement body enters the workspace; later messages are ignored and cleared content is refused',
  { skip: !database }, async () => {
    const fixture = await createRunSupplementPreparationFixture(database!, { requirementBody: '原任务已固定要求：按本期材料核对全部数字。' });
    try {
      const request = await prepareRunSupplementAuthoringRequest(fixture.preparationInput);
      assert.ok(fixture.requirement);
      await fixture.saveLaterRequirement('这条后续编辑不属于原任务，不得自动采用。');
      const before = await fixture.snapshot();
      const audits = async () => Number((await fixture.pool.query('SELECT count(*)::int AS n FROM bb_log_access_audit WHERE owner_user_id=$1', [fixture.owner])).rows[0].n);
      const auditBefore = await audits();
      await workspace(async cwd => {
        await request.prepare(cwd);
        const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
        assert.deepEqual(data.requirements, [fixture.requirement!.body]);
        assert.doesNotMatch(data.requirements.join('\n'), /后续编辑/);
      });
      assert.deepEqual(await fixture.snapshot(), before);
      assert.ok(await audits() > auditBefore, 'existing private-body access audit is retained');
      const snapshot = (await fixture.pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [fixture.requirement.snapshotId])).rows[0];
      await fixture.pool.query(`INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version)
        VALUES($1,$2,'prompt_snapshot',$3,$4,'retention_expired','synthetic-v1')`,
      [randomUUID(), fixture.owner, fixture.requirement.snapshotId, snapshot.object_key]);
      const cleared = await fixture.snapshot();
      await workspace(async cwd => { await assert.rejects(request.prepare(cwd), /Saved message content is unavailable/); });
      assert.deepEqual(await fixture.snapshot(), cleared);
    } finally { await fixture.cleanup(); }
  });
