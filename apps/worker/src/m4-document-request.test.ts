import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { loadM4Knowledge } from '@bondbuddy/api/m4-knowledge';
import type { RunSupplementFilePreparation } from '@bondbuddy/api/run-supplement-preparation';
import type { M4DocumentManifest } from '@bondbuddy/contracts';
import { buildM4DocumentRequest, loadM4DocumentSkill } from './m4-document-request.js';
import type { M4WorkerInput } from './m4-input.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';

function fixture() {
  const materialBytes = Buffer.from('Synthetic candidate evidence, current assets 200.'), oldBytes = makeWorkerDocxFixture({externalLink: false});
  const pin = {source_project_id: 'source-project', material_id: 'source', material_version: 1, sha256: digest(materialBytes)};
  const manifest: M4DocumentManifest = {version: 'm4-document-input-v1', kind: 'document', topic_id: 'topic',
    execution_scope_project_id: 'project', draft_version: 1, market: 'sse', offering: 'private', billing_task: 'm4_G02',
    input: {document_type: 'underwriter', source_material: pin, materials: [pin], template: null, edit_base: null,
      scope: 'whole', fields: {issuer_name: 'Synthetic'}, requirements: [{requirement_id: 'r', message_id: 'm', message_version: 1,
        text: '准确固定要求'}]}, template_material: null, knowledge: loadM4Knowledge('sse', 'underwriter', 'private')};
  const input: M4WorkerInput = {manifest, materials: [{pin, filename: 'evidence.txt', mediaType: 'text/plain', objectKey: 'material'}], artifacts: []};
  const skill = loadM4DocumentSkill(manifest), methodHash = digest('synthetic method');
  // Builder-only fixture; no persisted receipt or executable candidate is claimed.
  const preparation = {version: 'run-supplement-file-preparation-v1', kind: 'm4', owner: 'owner', projectId: 'project', runId: 'run',
    revision: 1, requestId: 'receipt', requestHash: digest('receipt'), checkpointHash: digest('checkpoint'),
    candidateInputHash: inputManifestHash(manifest), sourceExecution: {executionVersion: 1, inputRevision: 1, inputHash: digest('original')},
    planHash: digest('plan'), delta: {additions: [pin], replacements: [], unchanged: [],
      sourceProspectuses: {previous: [], current: []}, discardPreviousOutput: false},
    priorWork: {source: {kind: 'provider_result', resultId: 'result', resultSchemaVersion: 'codex-m4-document-v1'},
      resultHash: digest('result'), metadata: {method_hash: methodHash, skill_sha256: skill.sha256},
      files: ['document.docx', 'preparation-note.docx'].map(name => ({name, sha256: digest(oldBytes), byteSize: oldBytes.length}))},
  } as unknown as RunSupplementFilePreparation;
  const blobs = {getIfExistsBounded: async () => materialBytes} as unknown as PrivateBlobs;
  const request = () => buildM4DocumentRequest({context: {blobs, inputHash: preparation.candidateInputHash}, input, skill,
    methodHash, continuation: {preparation, readFile: async () => oldBytes}});
  return {input, skill, methodHash, preparation, oldBytes, materialBytes, blobs, request};
}
async function workspace(visit: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'bb-m4-request-'));
  try {await visit(cwd);} finally {await rm(cwd, {recursive: true, force: true});}
}

test('M4 shared writer carries saved document/note and delta while retaining the actual source, knowledge and original task', async () => {
  const f = fixture(), request = f.request();
  await workspace(async cwd => {
    await request.prepare(cwd); await request.verifyOriginals(cwd);
    const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    assert.equal(data.input_hash, f.preparation.candidateInputHash);
    assert.deepEqual(data.task, f.input.manifest);
    assert.deepEqual(data.requirements, ['准确固定要求']);
    assert.equal(data.skill.sha256, f.skill.sha256);
    assert.equal(data.knowledge.sha256, (f.input.manifest as M4DocumentManifest).knowledge!.sha256);
    assert.equal(data.materials[0].purpose, 'source_prospectus');
    assert.deepEqual(data.artifacts, []);
    assert.equal(data.task.input.edit_base, null);
    assert.deepEqual(data.continuation.delta, f.preparation.delta);
    assert.equal(data.continuation.previous_work.files.every((file: any) => file.use === 'source_reference'), true);
    assert.deepEqual(await readFile(join(cwd, 'previous_work/document.docx')), f.oldBytes);
    assert.deepEqual(await readFile(join(cwd, 'previous_work/preparation-note.docx')), f.oldBytes);
    assert.deepEqual(await readdir(join(cwd, 'output')), []);
    assert.match(await request.buildPrompt(), /旧工作可能含已过期事实/);
    assert.match(await request.buildPrompt(), /主文档、模板、正式 edit_base、知识及固定方法/);
  });
});

test('M4 saved work and continuation metadata are original inputs, so mutation cannot be collected as a valid request', async () => {
  for (const path of ['previous_work/document.docx', 'previous_work/preparation-note.docx', 'continuation.json', 'input.json', 'SKILL.md']) {
    const request = fixture().request();
    await workspace(async cwd => {
      await request.prepare(cwd); await chmod(join(cwd, path), 0o600); await writeFile(join(cwd, path), 'changed');
      await assert.rejects(request.verifyOriginals(cwd), /INPUT_REVISION_CONFLICT/);
    });
  }
});

test('M4 ordinary request retains its original prompt ending and has no supplement metadata', async () => {
  const f = fixture(), request = buildM4DocumentRequest({context: {blobs: f.blobs, inputHash: 'original-hash'},
    input: f.input, skill: f.skill, methodHash: f.methodHash});
  assert.doesNotMatch(await request.buildPrompt(), /continuation|previous_work|补料后的请求/);
  assert.match(await request.buildPrompt(), /只描述实际发生的工作，不写命令、路径、内部标识或推理内容。$/);
  await workspace(async cwd => {
    await request.prepare(cwd); await request.verifyOriginals(cwd);
    const data = JSON.parse(await readFile(join(cwd, 'input.json'), 'utf8'));
    assert.equal(data.input_hash, 'original-hash'); assert.equal(data.continuation, undefined);
    assert.deepEqual(data.task, f.input.manifest);
  });
});

test('M4 missing candidate bytes or changed saved bytes reject the workspace rather than substituting an old artifact', async () => {
  for (const kind of ['material', 'old_work'] as const) {
    const f = fixture(); if (kind === 'material') f.blobs.getIfExistsBounded = async () => null;
    const request = buildM4DocumentRequest({context: {blobs: f.blobs, inputHash: f.preparation.candidateInputHash},
      input: f.input, skill: f.skill, methodHash: f.methodHash,
      continuation: {preparation: f.preparation, readFile: async () => kind === 'old_work' ? Buffer.from('changed') : f.oldBytes}});
    await workspace(async cwd => {await assert.rejects(request.prepare(cwd), /INPUT_REVISION_CONFLICT/);});
  }
});
