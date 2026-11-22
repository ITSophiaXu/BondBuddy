import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validFileAuthoringRecovery } from './queue.js';
import { FILE_AUTHORING_RECOVERY_LIMITS, FILE_AUTHORING_CONTEXT_ROTATION_LIMIT, MODEL_ADAPTER_ERROR_CODES, isFileAuthoringDeadline } from '@bondbuddy/contracts';

const scope={owner:'owner',project:'project',run:'run',inputHash:'a'.repeat(64),attempt:'attempt',logical:'file-authoring-v1'};
const file=(path:string,size=10)=>({path,key:`owners/owner/projects/project/runs/run/file-authoring/recovery/attempt/${'b'.repeat(64)}/${path}`,sha256:'b'.repeat(64),byte_size:size});
const snapshot=()=>({version:'file-authoring-recovery-v1',input_hash:scope.inputHash,attempt_id:scope.attempt,logical_call_id:scope.logical,
  files:[file('input.json'),file('scratch/工作记录.md'),file('output/operations.json')]});

test('recovery metadata binds the original input, attempt and private file namespace',()=>{
  assert.equal(validFileAuthoringRecovery(snapshot(),scope),true);
  for(const field of ['input_hash','attempt_id','logical_call_id','version'])
    assert.equal(validFileAuthoringRecovery({...snapshot(),[field]:'different'},scope),false,field);
  for(const field of ['owner','project','run','inputHash','attempt','logical'])
    assert.equal(validFileAuthoringRecovery(snapshot(),{...scope,[field]:'foreign'}),false,field);
});

test('recovery metadata rejects traversal, duplicate files, bad hashes and resource overruns',()=>{
  const reject=(files:unknown[])=>assert.equal(validFileAuthoringRecovery({...snapshot(),files},scope),false);
  for(const path of ['../input.json','scratch/../file','scratch//file','scratch/./file','scratch\\file','scratch/a:b','scratch/a\nfile','scratch/file.','scratch/file ','/scratch/file','materials/m0.docx','task.md'])
    reject([file('input.json'),file(path)]);
  reject([file('input.json'),file('input.json')]);reject([file('scratch/only')]);reject([file('input.json',0)]);
  reject([file('input.json'),file('scratch/a'),file('scratch/a/b')]);
  reject([{...file('input.json'),sha256:'not-a-hash'}]);reject([{...file('input.json'),key:'foreign'}]);
  for(const size of [-1,0.5,NaN,Infinity,100*1024*1024+1])reject([file('input.json'),file('output/a',size)]);
  reject([file('input.json'),...Array.from({length:6},(_,n)=>file(`output/${n}`,100*1024*1024))]);
  const full=[file('input.json'),...Array.from({length:FILE_AUTHORING_RECOVERY_LIMITS.files-1},(_,n)=>file(`scratch/${n}`,0))];
  assert.equal(FILE_AUTHORING_RECOVERY_LIMITS.files,4096);
  assert.equal(validFileAuthoringRecovery({...snapshot(),files:full},scope),true);
  reject([...full,file('scratch/one-too-many',0)]);
  assert.deepEqual(FILE_AUTHORING_RECOVERY_LIMITS,{files:4096,fileBytes:100*1024*1024,totalBytes:512*1024*1024});
  const exactBytes=[file('input.json',1),...Array.from({length:5},(_,n)=>file(`output/${n}`,100*1024*1024)),file('output/last',12*1024*1024-1)];
  assert.equal(validFileAuthoringRecovery({...snapshot(),files:exactBytes},scope),true,'exact per-file and total byte caps remain accepted');
  reject([...exactBytes.slice(0,-1),file('output/last',12*1024*1024)]);
  assert.equal(validFileAuthoringRecovery({...snapshot(),files:[file('input.json'),file('output/empty',0)]},scope),true);
});


test('deadline evidence is canonical, optional for legacy snapshots, and retains expired values for terminal handling',()=>{
  assert.equal(FILE_AUTHORING_CONTEXT_ROTATION_LIMIT,32);
  assert.equal(MODEL_ADAPTER_ERROR_CODES.filter(code=>code==='MODEL_CONTEXT_ROTATION_REQUIRED').length,1);
  for(const deadline_at of ['2026-11-16T00:00:00.000Z','2000-01-01T00:00:00.000Z']){
    assert.equal(isFileAuthoringDeadline(deadline_at),true);
    assert.equal(validFileAuthoringRecovery({...snapshot(),deadline_at},scope),true);
  }
  for(const deadline_at of [undefined,null,0,'invalid','2026-11-16','2026-11-16T00:00:00Z',
    '2026-11-16T08:00:00.000+08:00','2026-02-30T00:00:00.000Z']){
    assert.equal(isFileAuthoringDeadline(deadline_at),false);
    assert.equal(validFileAuthoringRecovery({...snapshot(),deadline_at},scope),false);
  }
  assert.equal(validFileAuthoringRecovery(snapshot(),scope),true);
});
