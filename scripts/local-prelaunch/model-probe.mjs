// Run with `docker compose ... exec -T worker node /local-prelaunch/model-probe.mjs`.
// Uses the configured real supplier and the production contained adapter, never mocked output.
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {runContainedModelCall,loadCodexAdapterConfig} from '/app/apps/worker/dist/codex-adapter.js';
import {MemoryCodexJournal} from '/app/apps/worker/dist/codex-memory-journal.js';
const root=await mkdtemp('/var/lib/bondbuddy/parse-staging/bb-local-probe-');
const config={...loadCodexAdapterConfig(),work_root:root,timeout_ms:180000,authoring_timeout_ms:180000,max_schema_reasks:0};
try{
 const result=await runContainedModelCall({owner_user_id:'local-probe',project_id:'local-probe',job_id:'local-probe',run_id:'local-probe',trace_id:'local-probe',logical_call_id:'local-probe',prompt_snapshot_ref:'local-synthetic',result_schema_version:'local-prelaunch-probe-v1',output:{kind:'text'},
  prompt:'This is an authorized local connectivity check using synthetic input. Use Python and python-docx to create output/clean.docx and output/tracked.docx, each containing one paragraph: 本地真实模型生成链路验证通过. Do not research or create other content. Reply LOCAL_GENERATION_OK.',
  fileWorkspace:{prepare:async cwd=>{for(const folder of ['scratch','output'])await mkdir(join(cwd,folder),{mode:0o700});await writeFile(join(cwd,'input.json'),'{}',{mode:0o400});},
   collect:async cwd=>{const files=[];for(const name of ['clean.docx','tracked.docx']){const bytes=await readFile(join(cwd,'output',name));if(bytes.length<1000||bytes.subarray(0,2).toString()!=='PK')throw Error('Invalid probe Word');files.push({name,bytes:bytes.length});}return {files};}},
  onEvent:event=>{if(event.type==='turn.started')console.log(JSON.stringify({phase:'real_model_started'}));}
 },new MemoryCodexJournal(),config);
 console.log(JSON.stringify({phase:'real_model_result',status:result.status,error_code:result.error_code,value:result.value,attempts:result.attempts,real_supplier:true,synthetic_input:true}));
 if(result.status!=='completed')process.exitCode=1;
}catch(error){console.error(JSON.stringify({phase:'preflight_failed',name:error.name,code:error.code??null,
 message:String(error.message??'').replace(/gh[pousr]_[A-Za-z0-9_]+|Bearer\s+\S+/gi,'[redacted]').slice(0,500)}));process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});}
