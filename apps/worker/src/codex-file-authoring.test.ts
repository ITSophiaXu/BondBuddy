import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runContainedModelCall,loadCodexAdapterConfig,CodexOutputValidationError,type ContainedCallInput} from './codex-adapter.js';
import {MemoryCodexJournal} from './codex-memory-journal.js';

async function setup(){
  const root=await mkdtemp(join(tmpdir(),'bb-native-files-test-'));
  let prepared=0,collected=0;
  const config={...loadCodexAdapterConfig({BB_CODEX_PATH:process.env.BB_CODEX_PATH}),command:[process.execPath,fileURLToPath(new URL('../test-fixtures/codex/fake-file-authoring.mjs',import.meta.url))],work_root:root,timeout_ms:20,authoring_timeout_ms:5000};
  const input:ContainedCallInput={owner_user_id:'synthetic-owner',project_id:'synthetic-project',job_id:'synthetic-job',run_id:'synthetic-run',trace_id:'synthetic-run',logical_call_id:'file-authoring-v1',prompt_snapshot_ref:'synthetic-prompt',prompt:'SCENARIO:file_done',output:{kind:'text'},result_schema_version:'synthetic-file-v1',
    fileWorkspace:{prepare:async cwd=>{prepared++;for(const dir of ['scratch','output'])await mkdir(join(cwd,dir));await writeFile(join(cwd,'input.json'),'{}');},
      collect:async cwd=>{collected++;return {file:await readFile(join(cwd,'output/fixture.txt'),'utf8')};}}};
  return {root,config,input,counts:()=>({prepared,collected})};
}
test('file mode accepts prose, stores actual file result and replays without a second CLI', {skip:process.platform!=='linux'},async()=>{
  const s=await setup();try{
    const journal=new MemoryCodexJournal();const r=await runContainedModelCall(s.input,journal,s.config);
    assert.equal(r.status,'completed');assert.deepEqual(r.value,{file:'synthetic file'});
    assert.equal(r.attempts.length,1);assert.equal(r.attempts[0]!.adapter_version,'codex-file-authoring-1');
    assert.deepEqual(s.counts(),{prepared:1,collected:1});
    journal.prior={call_id:r.attempts[0]!.call_id,attempt_no:1,status:'completed',observed:true};
    journal.readCompleted=async()=>({value:r.value,result_sha256:r.attempts[0]!.result_sha256!});
    assert.equal((await runContainedModelCall(s.input,journal,s.config)).status,'reused');
    assert.deepEqual(s.counts(),{prepared:1,collected:1});
  }finally{await rm(s.root,{recursive:true,force:true});}
});
test('file mode cancellation kills the native command group and never collects or resends', {skip:process.platform!=='linux'},async()=>{
  const s=await setup();try{
    const abort=new AbortController(),journal=new MemoryCodexJournal();
    const r=await runContainedModelCall({...s.input,prompt:'SCENARIO:file_hang',signal:abort.signal,onEvent:e=>{if(e.type==='item.started')abort.abort();}},journal,s.config);
    assert.equal(r.status,'needs_reconcile');assert.equal(r.error_code,'MODEL_CANCELLED');assert.equal(r.attempts.length,1);
    assert.equal(r.attempts[0]!.usage.status,'unknown');assert.equal(s.counts().collected,0);
    journal.prior={call_id:r.attempts[0]!.call_id,attempt_no:1,status:'pending_reconcile',observed:true};
    assert.equal((await runContainedModelCall(s.input,journal,s.config)).status,'needs_reconcile');assert.equal(s.counts().prepared,1);
  }finally{await rm(s.root,{recursive:true,force:true});}
});
test('file mode validates actual output when a completed CLI has no final prose', {skip:process.platform!=='linux'},async()=>{
  const s=await setup();try{
    const result=await runContainedModelCall({...s.input,prompt:'SCENARIO:file_no_prose'},new MemoryCodexJournal(),s.config);
    assert.equal(result.status,'completed');assert.deepEqual(result.value,{file:'synthetic file'});
    assert.equal(result.attempts.length,1);assert.deepEqual(s.counts(),{prepared:1,collected:1});
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('known-invalid file output is a measured failure; storage errors still require reconciliation',{skip:process.platform!=='linux'},async()=>{
 const s=await setup();try{
  for(const [error,expected] of [[new CodexOutputValidationError('workpaper_source_coverage_incomplete'),'failed'],[new Error('synthetic_storage_error'),'needs_reconcile']] as const){
   const journal=new MemoryCodexJournal();
   const result=await runContainedModelCall({...s.input,fileWorkspace:{...s.input.fileWorkspace!,collect:async()=>{throw error;}}},journal,s.config);
   assert.equal(result.status,expected);assert.equal(result.attempts.length,1);
   assert.equal(result.attempts[0].usage.status,'measured');
   assert.equal(result.error_code,expected==='failed'?'MODEL_OUTPUT_SCHEMA_INVALID':'MODEL_RESULT_STORE_FAILED');
   assert.equal(result.value,null);
  }
 }finally{await rm(s.root,{recursive:true,force:true});}
});


test('413 saves working files before lease disposition and cleanup, then an audited retry resumes them in a smaller context',{skip:process.platform!=='linux'},async()=>{
  const s=await setup();try{
    const journal=new MemoryCodexJournal(),saved=new Map<string,Buffer>();let snapshots=0;
    const first=await runContainedModelCall({...s.input,prompt:'SCENARIO:file_payload',fileWorkspace:{...s.input.fileWorkspace!,completionCheck:true,
      onFailure:async(cwd,intent)=>{snapshots++;assert.equal(journal.observations.length,0);assert.equal(intent.attempt_no,1);
        for(const name of ['output/fixture.txt','scratch/ocr-state.json'])saved.set(name,await readFile(join(cwd,name)));}}},journal,s.config);
    assert.equal(first.error_code,'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');assert.equal(snapshots,1);
    assert.equal(first.attempts[0].usage.status,'unknown');assert.equal(s.counts().collected,0);
    assert.deepEqual(await readdir(s.root),[],'ephemeral directory cleaned only after snapshot');
    journal.prior={call_id:first.attempts[0].call_id,attempt_no:1,status:'failed',observed:true,operator_retry:true};
    const second=await runContainedModelCall({...s.input,prompt:'SCENARIO:file_resume',fileWorkspace:{...s.input.fileWorkspace!,recovery:true,
      prepare:async cwd=>{await s.input.fileWorkspace!.prepare(cwd);for(const [name,bytes] of saved)await writeFile(join(cwd,name),bytes);}}},journal,s.config);
    assert.equal(second.status,'completed');assert.deepEqual(second.value,{file:'synthetic completed work'});
    assert.equal(second.attempts[0].attempt_no,2);assert.equal(journal.intents.length,2);
    assert.equal(journal.observations[0].observation.usage.status,'unknown','earlier usage is not changed to zero');
  }finally{await rm(s.root,{recursive:true,force:true});}
});

test('a failed 413 checkpoint still records the error and never resends itself',{skip:process.platform!=='linux'},async()=>{
  const s=await setup();try{
    const journal=new MemoryCodexJournal();
    const result=await runContainedModelCall({...s.input,prompt:'SCENARIO:file_payload',fileWorkspace:{...s.input.fileWorkspace!,
      onFailure:async()=>{throw Error('synthetic snapshot store failure');}}},journal,s.config);
    assert.equal(result.error_code,'MODEL_PROVIDER_PAYLOAD_TOO_LARGE');assert.equal(journal.intents.length,1);
    assert.equal(journal.observations.length,1);assert.equal(journal.results.size,0);
    assert.deepEqual(await readdir(s.root),[]);
  }finally{await rm(s.root,{recursive:true,force:true});}
});
