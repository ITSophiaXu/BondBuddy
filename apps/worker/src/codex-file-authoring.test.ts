import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runContainedModelCall,loadCodexAdapterConfig,CodexOutputValidationError,type ContainedCallInput} from './codex-adapter.js';
import {MemoryCodexJournal} from './codex-memory-journal.js';
import {emptyUpdateDetails,FILE_AUTHORING_RECOVERY_LIMITS} from '@bondbuddy/contracts';
import {digest} from '@bondbuddy/api/data';
import {fileAuthoringStage} from './file-authoring-stage.js';
import type {UnifiedInput} from './unified-input.js';
import type {StageContext} from './run-pipeline.js';

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

test('native timeout retains its unknown usage while the actual authoring capture hook records bounded failures',{skip:process.platform!=='linux',timeout:60000},async()=>{
  for(const mode of ['capacity','storage','outcome_write','saved'] as const){
    const s=await setup();
    try{
      const original=Buffer.from('synthetic pinned source'),objects=new Map<string,Buffer>([['source',original]]);
      let puts=0,captureWrites=0;
      const ctx={run:{id:s.input.run_id,owner_user_id:s.input.owner_user_id,project_id:s.input.project_id,input_revision:1,input_hash:'a'.repeat(64)},
        lease:{jobId:s.input.job_id,checkpoint:{}},checkpoint:{},values:new Map(),signal:new AbortController().signal,
        blobs:{put:async(key:string,bytes:Buffer)=>{puts++;if(mode==='storage')throw Error('private storage diagnostic must not escape');objects.set(key,Buffer.from(bytes));},
          getIfExistsBounded:async(key:string)=>objects.get(key)??null}} as unknown as StageContext;
      const pin={material_id:'source',material_version:1,sha256:digest(original),role:'historical' as const};
      const input:UnifiedInput={requirements:[],materials:[{pin,filename:'source.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:'source',records:[],pending:[]}],
        manifest:{issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[pin],update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},
          authoring:{version:'unified_v1',requirements:[],source_prospectuses:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}}};
      const journal=new MemoryCodexJournal(),recordIntent=journal.recordIntent.bind(journal);
      journal.recordIntent=async intent=>{await recordIntent(intent);ctx.lease.checkpoint.file_authoring_recovery_captures={[intent.call_id]:{state:'prepared',failure_code:null}};};
      let result:Awaited<ReturnType<typeof runContainedModelCall>>|undefined;
      const stage=fileAuthoringStage({load:async()=>input,config:s.config,
        checkpoint:async(_pool,lease,key,value)=>{lease.checkpoint={...lease.checkpoint,stages:{...(lease.checkpoint.stages as object),[key]:value}};},
        capture:async(_pool,lease,attempt,_logical,outcome)=>{captureWrites++;assert.equal(journal.observations.length,0);if(mode==='outcome_write')throw Error('synthetic outcome write failed');
          const captures=lease.checkpoint.file_authoring_recovery_captures as Record<string,unknown>;captures[attempt]=outcome;},
        model:options=>({name:'model_generation',run:async()=>{
          const workspace=options.fileWorkspace!;
          result=await runContainedModelCall({...s.input,prompt:'SCENARIO:file_hang',fileWorkspace:{...workspace,prepare:async cwd=>{
            await workspace.prepare(cwd);
            if(mode==='capacity'){
              let remaining=FILE_AUTHORING_RECOVERY_LIMITS.totalBytes+1;
              for(let n=0;remaining>0;n++){
                const bytes=Math.min(FILE_AUTHORING_RECOVERY_LIMITS.fileBytes,remaining);
                const file=await open(join(cwd,`scratch/large-${n}.bin`),'wx');
                try{await file.truncate(bytes);}finally{await file.close();}
                remaining-=bytes;
              }
            }
          }}},journal,{...s.config,authoring_timeout_ms:1000,kill_grace_ms:100});
          return {kind:'stopped'};
        }})});
      await stage.run(ctx);assert.ok(result);assert.equal(result.error_code,'MODEL_TIMEOUT');assert.equal(result.status,'needs_reconcile');
      assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].usage.status,'unknown');assert.ok(['SIGTERM','SIGKILL'].includes(result.attempts[0].exit_signal??''));
      assert.equal(journal.intents.length,1);assert.equal(journal.observations.length,1);assert.equal(journal.results.size,0);
      const capture=(ctx.lease.checkpoint.file_authoring_recovery_captures as any)[journal.intents[0].call_id];
      assert.equal(capture.state,mode==='outcome_write'?'prepared':mode==='saved'?'saved':'failed');
      assert.equal(capture.failure_code,mode==='capacity'?'capacity_exceeded':mode==='storage'?'storage_failed':null);
      assert.equal(captureWrites,1);assert.equal(!!(ctx.lease.checkpoint.stages as any)?.file_authoring_recovery,['outcome_write','saved'].includes(mode));
      if(mode==='capacity')assert.equal(puts,0);
      assert.deepEqual(await readdir(s.root),[]);
    }finally{await rm(s.root,{recursive:true,force:true});}
  }
});
