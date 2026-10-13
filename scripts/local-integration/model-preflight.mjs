// Runs inside the same Linux image and permission profile as the real worker.
// This is an explicitly real, short model call using only synthetic input.
import {mkdir,writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {runContainedModelCall,loadCodexAdapterConfig} from '/app/apps/worker/dist/codex-adapter.js';
import {MemoryCodexJournal} from '/app/apps/worker/dist/codex-memory-journal.js';
import {loadM3RuntimeSkill} from '/app/apps/worker/dist/m3-runtime-skills.js';
import {loadM4RuntimeSkill} from '/app/apps/worker/dist/m4-runtime-skills.js';
const root=await mkdtemp('/var/lib/bondbuddy/parse-staging/bb-model-preflight-');
const config={...loadCodexAdapterConfig(),work_root:root,authoring_timeout_ms:180000,max_schema_reasks:0};
try{
 for(const id of ['m3-review','m3-public-review','m3-review-revision','m3-project-assistant'])loadM3RuntimeSkill(id);
 for(const id of ['m4-init-report','m4-private-summary','m4-underwriter','m4-legal','m4-project-qa','global-project-assistant'])loadM4RuntimeSkill(id);
 console.log(JSON.stringify({phase:'runtime_resources_verified',skills:10}));
 const result=await runContainedModelCall({owner_user_id:'local-preflight',project_id:'local-preflight',job_id:'local-preflight',run_id:'local-preflight',trace_id:'local-preflight',logical_call_id:'local-preflight',prompt_snapshot_ref:'local-synthetic',result_schema_version:'local-preflight-v1',output:{kind:'text'},
  prompt:'This is a connectivity check with synthetic data. Use /opt/venv/bin/python and python-docx to create output/clean.docx and output/tracked.docx containing one paragraph: 本地真实模型生成链路验证通过. Do not research or create other content. Then reply LOCAL_GENERATION_OK.',
  fileWorkspace:{prepare:async cwd=>{for(const dir of ['scratch','output'])await mkdir(join(cwd,dir),{mode:0o700});await writeFile(join(cwd,'input.json'),'{}',{mode:0o400});},
   collect:async cwd=>{const files={};for(const name of ['clean.docx','tracked.docx']){const data=await readFile(join(cwd,'output',name));if(data.length<1000||data.subarray(0,2).toString()!=='PK')throw Error('Invalid probe Word');files[name]=data.length;}return {files};}},
  onEvent:e=>{if(e.type==='turn.started')console.log(JSON.stringify({phase:'real_model_started'}));}
 },new MemoryCodexJournal(),config);
 console.log(JSON.stringify({phase:'real_model_result',status:result.status,error_code:result.error_code,value:result.value,attempts:result.attempts}));
 if(result.status!=='completed')process.exitCode=1;
}catch(error){console.error(JSON.stringify({phase:'preflight_failed',name:error.name,code:error.code??null,message:error.message}));process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});}
