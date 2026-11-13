import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '@bondbuddy/api/data';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import type { StageContext } from './run-pipeline.js';
import type { UnifiedInput } from './unified-input.js';
import { fileAuthoringStage } from './file-authoring-stage.js';
import { authorizedFileAuthoringRecovery, recoverFileAuthoringInput, restoreFileAuthoringWork,
  saveFileAuthoringRecovery, FILE_AUTHORING_RECOVERY_STAGE, type FileAuthoringRecovery } from './file-authoring-recovery.js';

const intent = { call_id: 'call-one', logical_call_id: 'file-authoring-v1' };
function fixture() {
  const objects = new Map<string, Buffer>();
  const ctx = { run: { id: 'run', owner_user_id: 'owner', project_id: 'project', input_hash: 'a'.repeat(64) },
    lease: { checkpoint: {} }, checkpoint: {}, signal: new AbortController().signal, values: new Map(),
    blobs: { put: async (key: string, bytes: Buffer) => { objects.set(key, Buffer.from(bytes)); },
      getIfExistsBounded: async (key: string, max: number) => { const b = objects.get(key); return b && b.length <= max ? b : null; } } } as unknown as StageContext;
  let writes = 0;
  const checkpoint: NonNullable<Parameters<typeof saveFileAuthoringRecovery>[3]>['checkpoint'] = async (_pool, lease, stage, value, completed) => {
    assert.equal(stage, FILE_AUTHORING_RECOVERY_STAGE); assert.equal(completed, false); writes++;
    lease.checkpoint = structuredClone({ ...lease.checkpoint, stages: { ...lease.checkpoint.stages as object, [stage]: value } });
  };
  const authorize = (snapshot: FileAuthoringRecovery, reason = 'file_authoring_payload_auto_retry') => {
    ctx.lease.checkpoint.operator_reconciliations = { [snapshot.attempt_id]: { attempt_id: snapshot.attempt_id,
      logical_call_id: snapshot.logical_call_id, reason_code: reason, decision: 'retry_unknown_usage' } };
  };
  return { ctx, objects, checkpoint, authorize, writes: () => writes };
}
async function workspace(root: string) {
  await mkdir(join(root, 'scratch/ocr'), { recursive: true }); await mkdir(join(root, 'output'));
  const input = Buffer.from(JSON.stringify({ version: 'test', input_hash: 'a'.repeat(64), format_tools: {}, revision_date: '2026-11-13T01:00:00.000Z' }));
  await writeFile(join(root, 'input.json'), input);
  await writeFile(join(root, 'scratch/工作记录.md'), '已完成主表逐行提取，下一步核对正文。');
  await writeFile(join(root, 'scratch/ocr/page-1.png'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(root, 'scratch/empty.txt'), '');
  await writeFile(join(root, 'output/operations.json'), '{"operations":[{"id":"done-1"}]}');
  return input;
}

test('a process restart restores all work bytes and the original revision timestamp only after durable authorization', async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bb-file-recovery-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target'); await mkdir(source); await mkdir(target);
    const original = await workspace(source);
    const snapshot = await saveFileAuthoringRecovery(f.ctx, source, intent, { checkpoint: f.checkpoint });
    assert.equal(f.writes(), 1); assert.equal(snapshot.files.length, 5);
    assert.equal(authorizedFileAuthoringRecovery(f.ctx, intent.logical_call_id), null, 'snapshot is not a retry authorization');
    f.authorize(snapshot);
    const restarted: StageContext = { ...f.ctx, lease: { ...f.ctx.lease, checkpoint: structuredClone(f.ctx.lease.checkpoint) }, checkpoint: {}, values: new Map() };
    const approved = authorizedFileAuthoringRecovery(restarted, intent.logical_call_id)!;
    const current = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), revision_date: '2026-11-14T01:00:00.000Z' }));
    assert.deepEqual(await recoverFileAuthoringInput(restarted, approved, current), original);
    await writeFile(join(target, 'task.md'), 'trusted current helper');
    await restoreFileAuthoringWork(restarted, target, approved);
    for (const ref of snapshot.files.filter(f => f.path !== 'input.json'))
      assert.deepEqual(await readFile(join(target, ref.path)), await readFile(join(source, ref.path)));
    assert.equal(await readFile(join(target, 'task.md'), 'utf8'), 'trusted current helper');
    assert.equal((await readFile(join(target, 'scratch/empty.txt'))).length, 0);
    assert.equal(restarted.checkpoint.model_generation, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('changed inputs, corrupt objects, foreign task keys and injected helper paths cannot be restored', async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bb-file-recovery-corrupt-'));
  try {
    const input = await workspace(root), snapshot = await saveFileAuthoringRecovery(f.ctx, root, intent, { checkpoint: f.checkpoint });
    await assert.rejects(recoverFileAuthoringInput(f.ctx, snapshot, Buffer.from(JSON.stringify({ ...JSON.parse(input.toString()), input_hash: 'b'.repeat(64) }))), /INPUT_REVISION_CONFLICT/);
    for (const mutate of [
      (s: FileAuthoringRecovery) => { s.input_hash = 'b'.repeat(64); },
      (s: FileAuthoringRecovery) => { s.attempt_id = 'foreign-attempt'; },
      (s: FileAuthoringRecovery) => { s.files[0]!.key = s.files[0]!.key.replace('/owner/', '/other/'); },
      (s: FileAuthoringRecovery) => { s.files[1]!.path = 'task.md'; },
      (s: FileAuthoringRecovery) => { s.files[1]!.path = 'scratch/../task.md'; },
      (s: FileAuthoringRecovery) => { s.files[1]!.path = 'scratch\\escape'; },
      (s: FileAuthoringRecovery) => { s.files.push({ ...s.files[0]! }); },
      (s: FileAuthoringRecovery) => { s.files = s.files.filter(f => f.path !== 'input.json'); },
    ]) {
      const bad = structuredClone(snapshot); mutate(bad);
      await assert.rejects(recoverFileAuthoringInput(f.ctx, bad, input), /AUTHORING_RECOVERY_UNSAFE/);
    }
    const ref = snapshot.files.find(f => f.path === 'input.json')!; f.objects.set(ref.key, Buffer.from('tampered'));
    await assert.rejects(recoverFileAuthoringInput(f.ctx, snapshot, input), /WORD_OUTPUT_BLOB_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('output-limit restore requires its exact audited reason and current attempt identity', async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bb-file-recovery-output-'));
  try {
    await workspace(root); const snapshot = await saveFileAuthoringRecovery(f.ctx, root, intent, { checkpoint: f.checkpoint });
    for (const reason of ['MODEL_OUTPUT_TOO_LARGE', 'retry_unknown_usage', 'file_authoring_manual_restart']) {
      f.authorize(snapshot, reason); assert.equal(authorizedFileAuthoringRecovery(f.ctx, intent.logical_call_id), null);
    }
    f.authorize(snapshot, 'file_authoring_output_limit_auto_retry');
    assert.deepEqual(authorizedFileAuthoringRecovery(f.ctx, intent.logical_call_id), snapshot);
    assert.equal(authorizedFileAuthoringRecovery(f.ctx, 'file-authoring-size-repair-1'), null);
    const audit = f.ctx.lease.checkpoint.operator_reconciliations as Record<string, Record<string, unknown>>;
    audit[intent.call_id].attempt_id = 'other';
    assert.equal(authorizedFileAuthoringRecovery(f.ctx, intent.logical_call_id), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed readback, file count and byte limits do not publish partial recovery checkpoints', async () => {
  for (const mode of ['file', 'count', 'total', 'readback', 'cancel'] as const) {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bb-file-recovery-bounds-'));
    try {
      await workspace(root);
      if (mode === 'readback') f.ctx.blobs.getIfExistsBounded = async () => Buffer.from('corrupt');
      if (mode === 'cancel') { const controller = new AbortController(); controller.abort(); f.ctx.signal = controller.signal; }
      const limits = { files: mode === 'count' ? 2 : 10, fileBytes: mode === 'file' ? 3 : 4096, totalBytes: mode === 'total' ? 3 : 8192 };
      await assert.rejects(saveFileAuthoringRecovery(f.ctx, root, intent, { checkpoint: f.checkpoint, limits }));
      assert.equal(f.writes(), 0); assert.equal(f.ctx.lease.checkpoint.stages, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('symlink directories, hardlinks and preexisting destination files cannot escape or overwrite work', async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bb-file-recovery-links-'));
  try {
    const source = join(root, 'source'), outside = join(root, 'outside'); await mkdir(source); await mkdir(outside);
    await workspace(source); await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(source, 'scratch', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(saveFileAuthoringRecovery(f.ctx, source, intent, { checkpoint: f.checkpoint }), /AUTHORING_RECOVERY_UNSAFE/);
    await rm(join(source, 'scratch', 'linked')); await link(join(outside, 'secret.txt'), join(source, 'scratch/hardlink'));
    await assert.rejects(saveFileAuthoringRecovery(f.ctx, source, intent, { checkpoint: f.checkpoint }), /AUTHORING_RECOVERY_UNSAFE/);
    await rm(join(source, 'scratch/hardlink'));
    const snapshot = await saveFileAuthoringRecovery(f.ctx, source, intent, { checkpoint: f.checkpoint });
    const target = join(root, 'target'); await mkdir(target); await mkdir(join(target, 'scratch'));
    await symlink(outside, join(target, 'scratch/ocr'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(restoreFileAuthoringWork(f.ctx, target, snapshot), /AUTHORING_RECOVERY_UNSAFE/);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside');
    const target2 = join(root, 'target2'); await mkdir(target2); await mkdir(join(target2, 'output'));
    await writeFile(join(target2, 'output/operations.json'), 'newer work');
    await assert.rejects(restoreFileAuthoringWork(f.ctx, target2, snapshot), { code: 'EEXIST' });
    assert.equal(await readFile(join(target2, 'output/operations.json'), 'utf8'), 'newer work');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authoring failure checkpoints work and the next authorized stage prepares a fresh context with the saved edits', async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'bb-file-recovery-stage-'));
  try {
    const source = Buffer.from('synthetic pinned original'); f.objects.set('source', source);
    const pin = { material_id: 'source', material_version: 1, sha256: digest(source), role: 'historical' };
    const input: UnifiedInput = { requirements: [], materials: [{ pin, filename: 'source.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'source', records: [], pending: [] }],
      manifest: { issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private', materials: [pin], update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' },
        authoring: { version: 'unified_v1', requirements: [], source_prospectuses: [], knowledge: [], knowledge_status: 'authoring_reference_not_compliance_approval' } } };
    const config = { command: [process.execPath], model_id: 'synthetic', model_provider: 'synthetic', base_url: 'http://localhost', wire_api: 'responses' as const,
      model_config_version: 'test', reasoning_effort: null, credential: { kind: 'env' as const, name: 'SYNTHETIC_TOKEN' }, work_root: root,
      timeout_ms: 1000, kill_grace_ms: 100, max_output_bytes: 4096, max_schema_reasks: 0, disabled_features: [], path_env: '' };
    let turns = 0;
    const stage = () => fileAuthoringStage({ load: async () => input, config, checkpoint: f.checkpoint, model: options => ({ name: 'model_generation', run: async () => {
      turns++; const cwd = join(root, `attempt-${turns}`); await mkdir(cwd);
      await options.fileWorkspace!.prepare(cwd);
      assert.equal(options.logicalCallId, intent.logical_call_id, 'recovery does not create another billed logical call');
      if (turns === 1) {
        assert.equal(options.name, 'file_authoring_v1');
        assert.equal(options.fileWorkspace!.recovery, false);
        await writeFile(join(cwd, 'scratch/工作记录.md'), 'already extracted data');
        await writeFile(join(cwd, 'output/operations.json'), '{"saved":true}');
        await options.fileWorkspace!.onFailure!(cwd, intent as Parameters<NonNullable<NonNullable<typeof options.fileWorkspace>['onFailure']>>[1]);
      } else {
        assert.match(options.name, /^file_authoring_v1_resume_[a-f0-9]{12}$/);
        assert.equal(options.fileWorkspace!.recovery, true);
        assert.equal(await readFile(join(cwd, 'output/operations.json'), 'utf8'), '{"saved":true}');
        assert.equal(await readFile(join(cwd, 'scratch/工作记录.md'), 'utf8'), 'already extracted data');
        assert.deepEqual(await readFile(join(cwd, 'materials/m0.docx')), source);
        assert.match(await options.buildPrompt(f.ctx), /已授权续跑/);
        assert.match(await readFile(join(cwd, 'task.md'), 'utf8'), /募集说明书/);
      }
      return { kind: 'stopped' };
    } }) });
    assert.equal((await stage().run(f.ctx)).kind, 'stopped');
    const snapshot = (f.ctx.lease.checkpoint.stages as Record<string, unknown>)[FILE_AUTHORING_RECOVERY_STAGE] as FileAuthoringRecovery;
    f.authorize(snapshot); f.ctx.checkpoint = {};
    assert.equal((await stage().run(f.ctx)).kind, 'stopped'); assert.equal(turns, 2); assert.equal(f.writes(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
