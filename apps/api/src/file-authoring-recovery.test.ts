import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validFileAuthoringRecovery } from './queue.js';

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
  reject([file('input.json'),...Array.from({length:3},(_,n)=>file(`output/${n}`,100*1024*1024))]);
  reject([file('input.json'),...Array.from({length:1024},(_,n)=>file(`scratch/${n}`,0))]);
  assert.equal(validFileAuthoringRecovery({...snapshot(),files:[file('input.json'),file('output/empty',0)]},scope),true);
});
