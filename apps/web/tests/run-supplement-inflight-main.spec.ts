// Synthetic generic worker mechanics, real full main/API/session/CSRF/PG/private disk bytes.
// The original run is seeded; no production business input gate, supplier, adoption or Word is claimed.
import {expect,test,type BrowserContext,type Locator,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RunSupplementDraftResponse} from '@bondbuddy/contracts';
import {digest} from '../../api/dist/data.js';
import {codexModelStage,runPipelineOnce} from '../../worker/dist/run-pipeline.js';
import {DEFAULT_DISABLED_FEATURES,type CodexAdapterConfig} from '../../worker/dist/codex-adapter.js';
import {startRealSupplement,type RealFixture} from './run-supplement-real-harness';

type Row=Record<string,unknown>;
type Evidence=Record<string,unknown>&{run:Row[];job:Row[];ownerJobs:Row[];outbox:Row[];creditEvents:Row[]};
type WorkerState={
  id:string;state:string;stage:string;input_revision:number;input_hash:string;execution_request_id:string;
  job_id:string;job_state:string;job_stage:string;user_pause_requested:boolean;lease_token:string|null;lease_until:Date|null;
  checkpoint:{stages?:Record<string,Record<string,unknown>>;provider_results?:Array<Record<string,unknown>>};
};
const expectedResult={answer:'SYNTHETIC saved in-flight result',n:16};
const logicalCallId='synthetic-inflight-pause-v1';
let real:Awaited<ReturnType<typeof startRealSupplement>>;
test.beforeAll(async()=>{real=await startRealSupplement();});
test.afterAll(async()=>{await real?.close();});
const action=(panel:Locator,name:string)=>panel.locator(`[data-supplement-action="${name}"]`);
const panelFor=(page:Page,f:RealFixture)=>page.locator(`[data-run-supplement="${f.runId}"]`);
async function auth(context:BrowserContext){
  await context.addCookies([{name:'bb_session',value:real.access,url:real.baseURL,httpOnly:true,sameSite:'Lax'},{name:'bb_csrf',value:real.csrf,url:real.baseURL,sameSite:'Lax'}]);
  // Guard egress only. Every API response and the page shell comes from the real server.
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['http:','https:'].includes(url.protocol)&&url.origin!==real.baseURL)throw Error(`Unexpected external request: ${url.origin}`);
    await route.continue();
  });
}
async function ready(page:Page,f:RealFixture){
  const panel=panelFor(page,f);await expect(panel).toBeVisible();
  const summary=panel.locator('summary').first();
  if(await summary.count()&&await summary.locator('..').evaluate(element=>element.tagName==='DETAILS'&&!(element as HTMLDetailsElement).open))await summary.click();
  await expect(panel.locator('[data-supplement-file]')).toBeVisible();return panel;
}
async function state(f:RealFixture){
  const result=await real.pool.query<WorkerState>(`SELECT r.id,r.state,r.stage,r.input_revision,r.input_hash,r.execution_request_id,
    j.id AS job_id,j.state AS job_state,j.stage AS job_stage,j.user_pause_requested,j.lease_token,j.lease_until,j.checkpoint
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id WHERE r.id=$1 AND r.owner_user_id=$2`,[f.runId,real.owner]);
  expect(result.rows).toHaveLength(1);return result.rows[0]!;
}
const evidence=async(f:RealFixture)=>await real.evidence(f) as unknown as Evidence;
async function durable(f:RealFixture){
  const rows:Record<string,Row[]>={};
  for(const [name,sql] of [
    ['attempts','SELECT * FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY id'],
    ['observations','SELECT * FROM bb_provider_call_observations WHERE job_id=$1 ORDER BY id'],
    ['runtime','SELECT * FROM bb_model_call_attempt_runtime WHERE attempt_id IN (SELECT id FROM bb_model_call_attempts WHERE job_id=$1) ORDER BY attempt_id'],
    ['results','SELECT * FROM bb_provider_result_refs WHERE job_id=$1 ORDER BY id'],
    ['prompts',"SELECT * FROM bb_snapshot_refs WHERE run_id=(SELECT run_id FROM bb_jobs WHERE id=$1) AND snapshot_kind='model_request' ORDER BY id"],
  ])rows[name!]=(await real.pool.query(sql!,[f.jobId])).rows;
  return rows;
}
function samePreparationOnly(f:RealFixture,before:Evidence,after:Evidence,receipt:RunSupplementDraftResponse){
  const {outbox:oldEvents,...oldState}=before,{outbox:newEvents,...newState}=after;
  expect(newState).toEqual(oldState);
  for(const old of oldEvents)expect(newEvents.find(next=>next.id===old.id),'Every prior outbox row remains exact').toEqual(old);
  const oldIds=new Set(oldEvents.map(event=>event.id)),added=newEvents.filter(event=>!oldIds.has(event.id));
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({owner_user_id:real.owner,aggregate_type:'run_supplement_draft',aggregate_id:f.runId,event_type:'run.supplement_draft_saved'});
  expect(added[0]!.payload).toEqual({run_id:f.runId,project_id:f.projectId,revision:receipt.revision,request_id:receipt.request_id,base_input_revision:1,base_input_hash:f.hash,adopted:false});
}

test('real main: an in-flight contained adapter finishes durably before manual pause permits preparation; original resume reuses its result',async({page,context})=>{
  test.setTimeout(90000);await page.setViewportSize({width:1440,height:960});await auth(context);
  const f=await real.fixture('m1'),initial=await evidence(f),stop=new AbortController();
  const controls=join(real.artifactRoot,`inflight-control-${randomUUID()}`);await mkdir(controls,{recursive:true});
  const startedPath=join(controls,'started.jsonl'),releasePath=join(controls,'release.txt');
  const starts=async()=>{
    try{return (await readFile(startedPath,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Row);}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  };
  const config:CodexAdapterConfig={
    command:[process.execPath,fileURLToPath(new URL('./fixtures/run-supplement-inflight-adapter.mjs',import.meta.url)),`--supplement-started=${startedPath}`,`--supplement-release=${releasePath}`],
    model_id:'synthetic-inflight-model',model_provider:'synthetic',base_url:'https://synthetic.invalid',wire_api:'responses',
    model_config_version:'synthetic-inflight-config-v1',reasoning_effort:null,credential:{kind:'env',name:'BB_SYNTHETIC_INFLIGHT_UNUSED_KEY'},
    work_root:join(controls,'work'),timeout_ms:60000,kill_grace_ms:100,max_output_bytes:1<<20,max_schema_reasks:0,
    disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH??'',web_search:'disabled',
  };
  let following=0;
  const model=codexModelStage({name:'model_generation',logicalCallId,config,
    schema:{type:'object',properties:{answer:{type:'string'},n:{type:'integer'}},required:['answer','n'],additionalProperties:false},
    validate:value=>typeof value==='object'&&value!==null&&(value as {answer?:unknown}).answer===expectedResult.answer&&(value as {n?:unknown}).n===16,
    resultSchemaVersion:'synthetic-inflight-result-v1',buildPrompt:async ctx=>`SYNTHETIC generic in-flight pause mechanics for ${ctx.run.id}; no business processing or document generation.`,
  });
  const execute=()=>runPipelineOnce({pool:real.pool,blobs:real.blobs,runKinds:['update'],leaseSeconds:30,signal:stop.signal,
    // These are generic worker mechanics stages. Production business input gates and delivery are outside this test.
    stages:[model,{name:'next_stage',run:async ctx=>{following++;expect(ctx.values.get('model_generation')).toEqual(expectedResult);return {kind:'pause',stage:'capability_not_ready',reason:'synthetic_mechanics_complete'};}}],
    onUnexpectedError:error=>{throw Error(`Unexpected generic worker error: ${JSON.stringify(error)}`);},
  });
  // The real runtime retries an idle claim. Full main polls can briefly hold the
  // run lock, and claim deliberately uses SKIP LOCKED instead of blocking them.
  const executeWhenAvailable=async()=>{
    const deadline=Date.now()+5000;let idleClaims=0;
    while(true){
      const outcome=await execute();if(outcome!=='idle')return outcome;
      const current=await state(f);
      expect(current,'An idle claim may only retry while the original job is still queued').toMatchObject({state:'queued',job_state:'queued'});
      idleClaims++;expect(Date.now(),`Timed out waiting for an unlocked queued run after ${idleClaims} idle claims`).toBeLessThan(deadline);
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  };
  let active:ReturnType<typeof execute>|undefined;
  try{
    await page.goto(real.baseURL+f.route);await expect(page.locator('#pause-run')).toBeVisible();
    active=executeWhenAvailable();void active.catch(()=>{});
    await expect.poll(async()=>(await starts()).length,{timeout:15000}).toBe(1);
    const started=await state(f);expect(started).toMatchObject({id:f.runId,state:'running',job_id:f.jobId,job_state:'running',user_pause_requested:false,input_revision:1,input_hash:f.hash});
    expect(started.lease_token).not.toBeNull();expect(started.lease_until).not.toBeNull();
    const inFlight=await durable(f);expect(inFlight.attempts).toHaveLength(1);expect(inFlight.results).toHaveLength(0);expect(inFlight.observations).toHaveLength(0);
    await page.reload();await expect(page.locator('#pause-run')).toBeVisible();
    const pauseResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/runs/${f.runId}/pause`);
    await page.locator('#pause-run').click();const pause=await pauseResponse;expect(pause.status()).toBe(200);expect(pause.request().headers()['x-bb-csrf']).toBe(real.csrf);
    expect(await pause.json()).toMatchObject({run_id:f.runId,state:'running'});
    const requested=await state(f);expect(requested).toMatchObject({state:'running',job_state:'running',user_pause_requested:true,lease_token:started.lease_token});
    expect(requested.lease_until).not.toBeNull();expect(following).toBe(0);
    const blocked=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`) as RunSupplementDraftResponse;
    expect(blocked).toMatchObject({run_id:f.runId,revision:0,adopted:false,can_save:false});expect(blocked.blocked_reason).toContain('等待已有工作保存完毕');
    const rejected=await fetch(`${real.baseURL}/api/v1/runs/${f.runId}/supplement-draft`,{method:'PUT',headers:{...real.headers,'content-type':'application/json'},
      body:JSON.stringify({request_id:randomUUID(),expected_revision:0,base_input_revision:1,base_input_hash:f.hash,changes:[]})});
    expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({code:'INPUT_REVISION_CONFLICT'});
    expect((await real.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1',[f.runId])).rows[0].n).toBe(0);
    expect(await durable(f)).toEqual(inFlight);
    await page.screenshot({path:join(real.artifactRoot,'m1-inflight-pause-pending-viewport.png')});

    await writeFile(releasePath,'release-synthetic-result',{mode:0o600});expect(await active).toBe('paused');active=undefined;
    const paused=await state(f);expect(paused).toMatchObject({id:f.runId,state:'paused',stage:'user_paused',job_id:f.jobId,job_state:'paused',job_stage:'user_paused',user_pause_requested:true,lease_token:null,lease_until:null});
    expect(paused.checkpoint.stages?.model_generation).toMatchObject({logical_call_id:logicalCallId});expect(following).toBe(0);
    const savedCall=await durable(f);for(const key of ['attempts','observations','runtime','results','prompts'])expect(savedCall[key],key).toHaveLength(1);
    expect(savedCall.attempts![0]).toMatchObject({job_id:f.jobId,logical_call_id:logicalCallId,attempt_no:1,status:'completed',usage_status:'measured'});
    expect(savedCall.observations![0]).toMatchObject({outcome:'completed',input_tokens:12,output_tokens:4});
    expect(savedCall.runtime![0]).toMatchObject({adapter:'codex_exec',error_code:null,exit_code:0});
    const result=savedCall.results![0]!,resultBytes=await real.blobs.get(String(result.result_ref));
    expect(digest(resultBytes)).toBe(String(result.result_sha256).trim());expect(resultBytes.length).toBe(Number(result.byte_size));expect(JSON.parse(resultBytes.toString('utf8'))).toEqual(expectedResult);
    expect(paused.checkpoint.provider_results).toEqual([expect.objectContaining({logical_call_id:logicalCallId,attempt_no:1,result_ref:result.result_ref,result_sha256:String(result.result_sha256).trim()})]);
    expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`)).toMatchObject({can_save:true,revision:0,adopted:false});

    await page.reload();const panel=await ready(page,f);await panel.locator('[data-supplement-intent]').selectOption('');await panel.locator('[data-supplement-role]').selectOption('audit');
    const uploadResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname));
    const supplementalBytes=Buffer.from('SYNTHETIC preparation after a real adapter checkpoint; not adopted.');
    await panel.locator('[data-supplement-file]').setInputFiles({name:'synthetic-after-inflight.txt',mimeType:'text/plain',buffer:supplementalBytes});
    const uploaded=await uploadResponse;expect(uploaded.status()).toBe(200);const material=await uploaded.json();await real.verifyBytes({projectId:f.projectId},material,supplementalBytes);
    await expect(action(panel,'save')).toBeEnabled();const beforeSave=await evidence(f);
    expect(beforeSave.creditEvents.length).toBeGreaterThan(0);expect(beforeSave.outbox.length).toBeGreaterThan(0);expect(beforeSave.ownerJobs.length).toBeGreaterThan(0);
    const savedResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
    await action(panel,'save').click();const saved=await savedResponse;expect(saved.status()).toBe(200);expect(saved.request().headers()['x-bb-csrf']).toBe(real.csrf);
    const receipt=await saved.json() as RunSupplementDraftResponse;expect(receipt).toMatchObject({run_id:f.runId,revision:1,adopted:false,
      saved_work:{status:'captured',result_count:1},changes:[{replaces:null,material:{material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}}]});
    expect(receipt.saved_work.stage_count).toBeGreaterThanOrEqual(1);
    const frozenWork=(await real.pool.query(`SELECT w.*,c.attempt_id,c.result_id FROM bb_run_supplement_saved_work w
      JOIN bb_run_supplement_saved_results c ON c.run_id=w.run_id AND c.supplement_revision=w.supplement_revision
      WHERE w.run_id=$1 AND w.supplement_revision=1`,[f.runId])).rows;
    expect(frozenWork).toHaveLength(1);expect(frozenWork[0]).toMatchObject({execution_version:1,input_revision:1,input_hash:f.hash,
      job_id:f.jobId,source_checkpoint:paused.checkpoint,attempt_id:savedCall.attempts![0]!.id,result_id:result.id});
    expect(JSON.stringify(receipt)).not.toContain(String(result.result_ref));expect(JSON.stringify(receipt)).not.toContain(String(result.id));
    await expect(panel).toContainText('已保存工作记录');
    await expect(panel).toContainText('草稿已保存');const afterSave=await evidence(f);samePreparationOnly(f,beforeSave,afterSave,receipt);expect(await durable(f)).toEqual(savedCall);
    await page.reload();const restored=await ready(page,f);await expect(restored).toContainText('synthetic-after-inflight.txt');await expect(restored).toContainText('尚未采用');await expect(action(restored,'save')).toBeDisabled();
    await restored.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:join(real.artifactRoot,'m1-inflight-saved-viewport.png')});await page.screenshot({path:join(real.artifactRoot,'m1-inflight-saved-full.png'),fullPage:true});

    await page.locator('#resume-run').click();const dialog=page.locator('.run-supplement-resume-dialog');await expect(dialog).toBeVisible();await expect(dialog).toContainText('原材料');
    const resumeResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/runs/${f.runId}/resume`);
    await dialog.locator('[data-supplement-resume-confirm]').click();expect((await resumeResponse).status()).toBe(200);
    const resumed=await state(f);expect(resumed).toMatchObject({id:f.runId,state:'queued',job_id:f.jobId,job_state:'queued',user_pause_requested:false,input_revision:1,input_hash:f.hash,execution_request_id:started.execution_request_id});
    expect(resumed.checkpoint).toEqual(paused.checkpoint);expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`)).toMatchObject({revision:1,adopted:false,can_save:false});
    const resumedEvidence=await evidence(f),identities=(rows:Row[])=>rows.map(({id,run_id})=>({id,run_id}));expect(identities(resumedEvidence.ownerJobs)).toEqual(identities(afterSave.ownerJobs));
    active=executeWhenAvailable();void active.catch(()=>{});expect(await active).toBe('paused');active=undefined;
    expect(following).toBe(1);expect(await starts()).toHaveLength(1);expect(await durable(f)).toEqual(savedCall);
    const replayed=await state(f);expect(replayed).toMatchObject({id:f.runId,job_id:f.jobId,state:'paused',stage:'capability_not_ready',input_revision:1,input_hash:f.hash,execution_request_id:started.execution_request_id});
    expect(replayed.checkpoint.stages?.model_generation).toEqual(paused.checkpoint.stages?.model_generation);expect(replayed.checkpoint.provider_results).toEqual(paused.checkpoint.provider_results);
    const finalEvidence=await evidence(f);expect(identities(finalEvidence.ownerJobs)).toEqual(identities(afterSave.ownerJobs));
    for(const key of ['input','creditEvents','reservations','lots','creditAccount','balance'])expect(finalEvidence[key],key).toEqual(initial[key]);
    expect(await real.blobs.get(String(result.result_ref))).toEqual(resultBytes);
    const exactReceipt=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft?request_id=${receipt.request_id}`);expect(exactReceipt).toMatchObject({request_id:receipt.request_id,revision:1,adopted:false,
      saved_work:{status:'captured',result_count:1}});
    // The following stage paused without saving new work. Replaying the same
    // original result therefore preserves the captured work boundary exactly.
    expect(replayed.checkpoint).toEqual(paused.checkpoint);
    await writeFile(join(real.artifactRoot,'m1-inflight-assertions.json'),JSON.stringify({synthetic:true,full_main:true,
      scope:'Generic worker mechanics with a controlled local Codex subprocess, real durable journal and private disk bytes. Seeded original run; no business execution, supplier, Azure, adoption, surcharge or Word acceptance.',
      started,requested,blocked,paused,savedCall,receipt,frozenWork,beforeSave,afterSave,resumed,replayed,finalEvidence,adapterStarts:await starts()},null,2));
  }finally{
    stop.abort();await writeFile(releasePath,'release-synthetic-result',{mode:0o600}).catch(()=>{});await active?.catch(()=>{});
  }
});
