import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { createRunSupplementFilePreparationFixture } from '../../api/dist/run-supplement-file-preparation-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { loadM4RuntimeSkill } from './m4-runtime-skills.js';
import { buildM4Method } from './m4-method.js';
import { prepareRunSupplementM4Request } from './run-supplement-m4-request.js';

const database = await isolatedTestDatabase(undefined, 'supplement-m4-request');
const config = loadCodexAdapterConfig({});
const method = await buildM4Method('document', loadM4RuntimeSkill('m4-underwriter'), config);
async function fixture() {return createRunSupplementFilePreparationFixture(database!, 'm4', {method});}
async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-supplement-m4-'));
  try {await visit(cwd);} finally {await rm(cwd, {recursive: true, force: true});}
}

test('real saved M4 receipt enters the shared writer with exact old Word, candidate material delta and frozen source/template/method',
  {skip: !database}, async () => {
    const f = await fixture();
    try {
      const before = await f.snapshot(), request = await prepareRunSupplementM4Request(f.preparationInput, {config});
      const again = await prepareRunSupplementM4Request(f.preparationInput, {config});
      assert.equal(request.preparation.planHash, again.preparation.planHash);
      assert.equal(request.preparation.priorWork.metadata.method_hash, inputManifestHash(method));
      await workspace(async cwd => {
        await request.prepare(cwd); await request.verifyOriginals(cwd);
        const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
        assert.equal(data.input_hash, f.preparationInput.expectedCandidateInputHash);
        assert.notEqual(data.input_hash, f.hash);
        assert.deepEqual(data.task.input.source_material, f.manifest.input.source_material);
        assert.deepEqual(data.task.input.template, f.manifest.input.template);
        assert.deepEqual(data.task.input.edit_base, f.manifest.input.edit_base);
        assert.deepEqual(data.task.knowledge, f.manifest.knowledge);
        assert.deepEqual(data.continuation.delta, request.preparation.delta);
        assert.equal(data.continuation.previous_work.metadata.method_hash, inputManifestHash(method));
        assert.equal(data.skill.sha256, method.skill_sha256);
        assert.deepEqual(data.artifacts, []);
        for (const name of ['document.docx', 'preparation-note.docx'])
          assert.deepEqual(await readFile(join(cwd, 'previous_work', name)), f.fileBytes.get(name));
        for (const material of data.materials) {
          const expected = request.preparation.materials.find(item => item.pin.material_id === material.material_id)!;
          assert.deepEqual(await readFile(join(cwd, material.path)), f.objects.get(expected.objectKey));
        }
        assert.equal(data.materials.some((material: any) => material.material_id === f.added.material_id), true);
        assert.equal(data.materials.find((material: any) => material.material_id === f.first.material_id).purpose, 'source_prospectus');
        assert.equal(data.materials.find((material: any) => material.material_id === f.last.material_id).purpose, 'template');
        assert.deepEqual(await readdir(join(cwd, 'output')), []);
        assert.match(await request.buildPrompt(), /旧工作可能含已过期事实/);
      });
      assert.deepEqual(await f.snapshot(), before);
    } finally {await f.cleanup();}
  });

test('M4 original method changes and caller metadata mutation cannot silently select another execution request',
  {skip: !database}, async () => {
    const f = await fixture();
    try {
      const before = await f.snapshot();
      await assert.rejects(prepareRunSupplementM4Request(f.preparationInput, {config: {...config, model_id: 'changed-model'}}), /m4_document_method_changed/);
      const request = await prepareRunSupplementM4Request(f.preparationInput, {config});
      request.preparation.manifest.input.template = null;
      request.preparation.priorWork.metadata.method_hash = '0'.repeat(64);
      request.preparation.candidateInputHash = '0'.repeat(64);
      await workspace(async cwd => {
        await request.prepare(cwd);
        const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
        assert.deepEqual(data.task.input.template, f.manifest.input.template);
        assert.equal(data.input_hash, f.preparationInput.expectedCandidateInputHash);
        assert.equal(data.continuation.previous_work.metadata.method_hash, inputManifestHash(method));
      });
      assert.deepEqual(await f.snapshot(), before);
    } finally {await f.cleanup();}
  });

test('M4 private old work loss and source-project deletion during actual workspace I/O refuse preparation without further durable changes',
  {skip: !database}, async () => {
    for (const kind of ['old_file', 'source_during_io'] as const) {
      const f = await fixture();
      try {
        let changed = false, expected: unknown;
        const blobs = kind === 'old_file' ? f.blobs : {...f.blobs, readToFile: async (key: string, path: string | null, max: number) => {
          const bytes = await f.blobs.getIfExistsBounded(key, max); if (!bytes) return null;
          if (path) await writeFile(path, bytes, {mode: 0o400});
          if (!changed) {
            await f.pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1 AND owner_user_id=$2', [f.sourceProject, f.owner]);
            changed = true; expected = await f.snapshot();
          }
          return {sha256: digest(bytes), byteSize: bytes.length};
        }};
        const request = await prepareRunSupplementM4Request({...f.preparationInput, blobs}, {config});
        if (kind === 'old_file') {f.objects.delete(f.files['document.docx'].key); expected = await f.snapshot();}
        await workspace(async cwd => {await assert.rejects(request.prepare(cwd), /已保存工作|INPUT_REVISION_CONFLICT/);});
        if (kind === 'source_during_io') assert.equal(changed, true);
        assert.deepEqual(await f.snapshot(), expected);
      } finally {await f.cleanup();}
    }
  });
