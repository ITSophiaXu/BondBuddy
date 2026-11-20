import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '@bondbuddy/api/data';
import { validFileAuthoringRecovery } from '@bondbuddy/api/queue';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import type { StageContext } from './run-pipeline.js';
import type { UnifiedInput } from './unified-input.js';
import { fileAuthoringStage } from './file-authoring-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import { authorizedFileAuthoringRecovery, fileAuthoringContextDeadline, recoverFileAuthoringInput, restoreFileAuthoringWork,
  saveFileAuthoringRecovery, FILE_AUTHORING_RECOVERY_STAGE, FILE_AUTHORING_RECOVERY_LIMITS, type FileAuthoringRecovery } from './file-authoring-recovery.js';

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
      logical_call_id: snapshot.logical_call_id, reason_code: reason, decision: 'retry_unknown_usage', ...(snapshot.deadline_at?{deadline_at:snapshot.deadline_at}:{}) } };
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
    f.authorize(snapshot, 'file_authoring_timeout_auto_retry');
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
      if(['file','count','total'].includes(mode))assert.equal(f.objects.size,0,'known capacity failures do not upload orphan fragments');
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
      timeout_ms: 10000, kill_grace_ms: 100, max_output_bytes: 4096, max_schema_reasks: 0, disabled_features: [], path_env: '' };
    let turns = 0;
    // This fixture deliberately uses opaque pinned bytes; it exercises snapshot
    // restoration only. Renderer capability has separate real-DOCX regressions.
    const stage = () => fileAuthoringStage({ load: async () => input, renderer:async()=>{}, config, checkpoint: f.checkpoint, model: options => ({ name: 'model_generation', run: async () => {
      turns++; const cwd = join(root, `attempt-${turns}`); await mkdir(cwd);
      await options.fileWorkspace!.prepare(cwd);
      assert.equal(typeof options.config,'object');
      const guarded=options.config as typeof config & {model_gateway:string;model_max_request_bytes:number};
      assert.equal(guarded.model_gateway,'enforce');assert.equal(guarded.model_max_request_bytes,2*1024*1024);
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
        assert.equal(options.fileWorkspace!.deadlineAt,(f.ctx.lease.checkpoint.stages as Record<string,FileAuthoringRecovery>)[FILE_AUTHORING_RECOVERY_STAGE].deadline_at);
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
    assert.ok(snapshot.deadline_at);
    f.authorize(snapshot); f.ctx.checkpoint = {};
    assert.equal((await stage().run(f.ctx)).kind, 'stopped'); assert.equal(turns, 2); assert.equal(f.writes(), 1);
    const expired={...snapshot,deadline_at:new Date(Date.now()-1000).toISOString()};
    (f.ctx.lease.checkpoint.stages as Record<string,FileAuthoringRecovery>)[FILE_AUTHORING_RECOVERY_STAGE]=expired;f.authorize(expired,'file_authoring_context_rotation');
    assert.deepEqual(await stage().run(f.ctx),{kind:'fail',code:'MODEL_TIMEOUT'});
    assert.equal(turns,3,'the expired deadline is checked during preparation before any new provider call');
    const reuse=fileAuthoringStage({load:async()=>input,config,model:()=>({name:'model_generation',run:async()=>({kind:'done',value:'already-completed'})})});
    assert.deepEqual(await reuse.run(f.ctx),{kind:'done',value:'already-completed'},'deadline expiry cannot block reuse of a completed result');
  } finally { await rm(root, { recursive: true, force: true }); }
});


for (const mode of ['transient', 'persistent', 'lease_lost'] as const)
test(`capture ${mode} failure retries only transient storage within the original lease`, async () => {
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-recovery-retry-'));
  try {
    const input:UnifiedInput={requirements:[],materials:[],manifest:{issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[],
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},
      authoring:{version:'unified_v1',requirements:[],source_prospectuses:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}}};
    f.ctx.lease.checkpoint.file_authoring_recovery_captures={[intent.call_id]:{logical_call_id:intent.logical_call_id,state:'pending'}};
    const savedPut=f.ctx.blobs.put.bind(f.ctx.blobs),outcomes:unknown[]=[];
    let failedPuts=0,checkpointCalls=0,modelTurns=0;
    f.ctx.blobs.put=async(...args)=>{
      if(mode==='persistent'||mode==='transient'&&failedPuts<2){failedPuts++;throw Error('synthetic_blob_transient_failure');}
      return savedPut(...args);
    };
    const stage=fileAuthoringStage({load:async()=>input,config:{...loadCodexAdapterConfig({}),work_root:root},
      checkpoint:async(...args)=>{checkpointCalls++;if(mode==='lease_lost')throw Object.assign(Error('Worker lease expired'),{code:'ALREADY_TERMINAL'});await f.checkpoint!(...args);},
      capture:async(_pool,_lease,_attempt,_logical,outcome)=>{outcomes.push(outcome);},
      model:options=>({name:'model_generation',run:async()=>{
        modelTurns++;const cwd=join(root,'cwd');await mkdir(cwd);await options.fileWorkspace!.prepare(cwd);
        await writeFile(join(cwd,'output/operations.json'),'{"saved":"same lease work"}');
        const capture=()=>options.fileWorkspace!.onFailure!(cwd,intent as Parameters<NonNullable<NonNullable<typeof options.fileWorkspace>['onFailure']>>[1]);
        if(mode==='transient')await capture();else await assert.rejects(capture());
        return {kind:'stopped'};
      }})});
    assert.equal((await stage.run(f.ctx)).kind,'stopped');assert.equal(modelTurns,1,'snapshot retries never send another model turn');
    assert.equal(failedPuts,mode==='persistent'?3:mode==='transient'?2:0);
    assert.equal(checkpointCalls,mode==='persistent'?0:1,'lease loss is never retried');
    assert.deepEqual(outcomes,mode==='transient'?[{state:'saved',failure_code:null}]:[{state:'failed',failure_code:mode==='persistent'?'storage_failed':'capture_failed'}]);
    assert.equal(f.writes(),mode==='transient'?1:0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('1271-file workspaces save and restore completely while 4097 files cannot publish a checkpoint', async () => {
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-recovery-many-files-'));
  try{
    const source=join(root,'source'),target=join(root,'target');
    await mkdir(join(source,'scratch'),{recursive:true});await mkdir(join(source,'output'));await mkdir(target);
    const input=Buffer.from(JSON.stringify({version:'synthetic',input_hash:f.ctx.run.input_hash}));
    await writeFile(join(source,'input.json'),input);
    const add=async(from:number,to:number)=>{for(let start=from;start<to;start+=64)await Promise.all(Array.from({length:Math.min(64,to-start)},(_,offset)=>{
      const i=start+offset;return writeFile(join(source,'scratch','file-'+i+'.bin'),Buffer.from([i%256,0,255]));
    }));};
    await add(0,1270);
    const snapshot=await saveFileAuthoringRecovery(f.ctx,source,intent,{checkpoint:f.checkpoint});
    assert.equal(snapshot.files.length,1271);assert.equal(f.writes(),1);
    assert.equal(validFileAuthoringRecovery(snapshot,{owner:'owner',project:'project',run:'run',inputHash:f.ctx.run.input_hash,attempt:intent.call_id,logical:intent.logical_call_id}),true);
    f.authorize(snapshot,'file_authoring_timeout_auto_retry');
    const approved=authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id)!;
    await writeFile(join(target,'input.json'),await recoverFileAuthoringInput(f.ctx,approved,input));
    await restoreFileAuthoringWork(f.ctx,target,approved);
    for(const file of snapshot.files)assert.deepEqual(await readFile(join(target,file.path)),await readFile(join(source,file.path)));
    assert.equal(FILE_AUTHORING_RECOVERY_LIMITS.files,4096);
    await add(1270,FILE_AUTHORING_RECOVERY_LIMITS.files-1);
    const boundary=await saveFileAuthoringRecovery(f.ctx,source,intent,{checkpoint:f.checkpoint});
    assert.equal(boundary.files.length,4096);assert.equal(f.writes(),2);
    assert.equal(validFileAuthoringRecovery(boundary,{owner:'owner',project:'project',run:'run',inputHash:f.ctx.run.input_hash,attempt:intent.call_id,logical:intent.logical_call_id}),true);
    const boundaryTarget=join(root,'boundary-target');await mkdir(boundaryTarget);
    f.authorize(boundary,'file_authoring_timeout_auto_retry');
    const boundaryApproved=authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id)!;
    await writeFile(join(boundaryTarget,'input.json'),await recoverFileAuthoringInput(f.ctx,boundaryApproved,input));
    await restoreFileAuthoringWork(f.ctx,boundaryTarget,boundaryApproved);
    for(const file of boundary.files)assert.deepEqual(await readFile(join(boundaryTarget,file.path)),await readFile(join(source,file.path)));
    const last=boundary.files.at(-1)!,extraPath='scratch/extra.bin';
    const oversized={...boundary,files:[...boundary.files,{...last,path:extraPath,key:last.key.slice(0,-last.path.length)+extraPath}]};
    const rejectedTarget=join(root,'rejected-target');await mkdir(rejectedTarget);
    const read=f.ctx.blobs.getIfExistsBounded;let reads=0;
    f.ctx.blobs.getIfExistsBounded=async(...args)=>{reads++;return read(...args);};
    await assert.rejects(recoverFileAuthoringInput(f.ctx,oversized,input),/AUTHORING_RECOVERY_UNSAFE/);
    await assert.rejects(restoreFileAuthoringWork(f.ctx,rejectedTarget,oversized),/AUTHORING_RECOVERY_UNSAFE/);
    assert.equal(reads,0,'oversized metadata is rejected before reading recovery objects');
    assert.deepEqual(await readdir(rejectedTarget),[]);
    await add(FILE_AUTHORING_RECOVERY_LIMITS.files-1,FILE_AUTHORING_RECOVERY_LIMITS.files);
    const objectsBefore=f.objects.size;
    await assert.rejects(saveFileAuthoringRecovery(f.ctx,source,intent,{checkpoint:f.checkpoint}),/AUTHORING_RECOVERY_UNSAFE/);
    assert.equal(f.writes(),2,'excess files must not publish a partial checkpoint');
    assert.equal(f.objects.size,objectsBefore,'file count is rejected before any additional Blob writes');
  }finally{await rm(root,{recursive:true,force:true});}
});


test('context rotation retains the first intent deadline across snapshots and rejects missing or extended bindings',async()=>{
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'bb-context-deadline-'));
  try{
    await workspace(root);
    const deadline=new Date(Date.now()+60000).toISOString();
    f.ctx.lease.checkpoint.file_authoring_recovery_captures={first:{logical_call_id:intent.logical_call_id,deadline_at:deadline}};
    assert.equal(fileAuthoringContextDeadline(f.ctx,intent.logical_call_id),deadline);
    const snapshot=await saveFileAuthoringRecovery(f.ctx,root,intent,{checkpoint:f.checkpoint});
    assert.equal(snapshot.deadline_at,deadline);
    f.authorize(snapshot,'file_authoring_context_rotation');
    assert.deepEqual(authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id),snapshot);
    const extended=new Date(Date.parse(deadline)+1000).toISOString();
    await assert.rejects(saveFileAuthoringRecovery(f.ctx,root,intent,{checkpoint:f.checkpoint,deadlineAt:extended}),/AUTHORING_RECOVERY_UNSAFE/);
    const audit=f.ctx.lease.checkpoint.operator_reconciliations as Record<string,Record<string,unknown>>;
    audit[intent.call_id].deadline_at=extended;
    assert.throws(()=>authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id),/AUTHORING_RECOVERY_UNSAFE/);
    audit[intent.call_id].deadline_at=deadline;
    const stages=f.ctx.lease.checkpoint.stages as Record<string,FileAuthoringRecovery>;
    delete stages[FILE_AUTHORING_RECOVERY_STAGE].deadline_at;
    assert.throws(()=>authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id),/AUTHORING_RECOVERY_UNSAFE/);
    const legacy={...snapshot};delete legacy.deadline_at;
    f.ctx.lease.checkpoint.file_authoring_recovery_captures={};stages[FILE_AUTHORING_RECOVERY_STAGE]=legacy;f.authorize(legacy,'file_authoring_context_rotation');
    assert.throws(()=>authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id),/AUTHORING_RECOVERY_UNSAFE/);
    f.authorize(legacy,'file_authoring_payload_auto_retry');
    assert.deepEqual(authorizedFileAuthoringRecovery(f.ctx,intent.logical_call_id),legacy,'historical faults keep their prior restore contract');
  }finally{await rm(root,{recursive:true,force:true});}
});
