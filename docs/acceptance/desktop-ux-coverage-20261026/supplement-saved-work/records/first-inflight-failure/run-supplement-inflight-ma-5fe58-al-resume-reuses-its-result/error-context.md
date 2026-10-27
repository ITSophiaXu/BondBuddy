# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-inflight-main.spec.ts >> real main: an in-flight contained adapter finishes durably before manual pause permits preparation; original resume reuses its result
- Location: tests\run-supplement-inflight-main.spec.ts:71:1

# Error details

```
Error: expect(received).toMatchObject(expected)

- Expected  - 1
+ Received  + 1

@@ -2,8 +2,8 @@
    "adopted": false,
    "request_id": "cf5320a2-d3e7-4c53-b41d-9357892a2d98",
    "revision": 1,
    "saved_work": Object {
      "result_count": 1,
-     "status": "stale_boundary",
+     "status": "captured",
    },
  }
```

# Test source

```ts
  82  |     model_id:'synthetic-inflight-model',model_provider:'synthetic',base_url:'https://synthetic.invalid',wire_api:'responses',
  83  |     model_config_version:'synthetic-inflight-config-v1',reasoning_effort:null,credential:{kind:'env',name:'BB_SYNTHETIC_INFLIGHT_UNUSED_KEY'},
  84  |     work_root:join(controls,'work'),timeout_ms:60000,kill_grace_ms:100,max_output_bytes:1<<20,max_schema_reasks:0,
  85  |     disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH??'',web_search:'disabled',
  86  |   };
  87  |   let following=0;
  88  |   const model=codexModelStage({name:'model_generation',logicalCallId,config,
  89  |     schema:{type:'object',properties:{answer:{type:'string'},n:{type:'integer'}},required:['answer','n'],additionalProperties:false},
  90  |     validate:value=>typeof value==='object'&&value!==null&&(value as {answer?:unknown}).answer===expectedResult.answer&&(value as {n?:unknown}).n===16,
  91  |     resultSchemaVersion:'synthetic-inflight-result-v1',buildPrompt:async ctx=>`SYNTHETIC generic in-flight pause mechanics for ${ctx.run.id}; no business processing or document generation.`,
  92  |   });
  93  |   const execute=()=>runPipelineOnce({pool:real.pool,blobs:real.blobs,runKinds:['update'],leaseSeconds:30,signal:stop.signal,
  94  |     // These are generic worker mechanics stages. Production business input gates and delivery are outside this test.
  95  |     stages:[model,{name:'next_stage',run:async ctx=>{following++;expect(ctx.values.get('model_generation')).toEqual(expectedResult);return {kind:'pause',stage:'capability_not_ready',reason:'synthetic_mechanics_complete'};}}],
  96  |     onUnexpectedError:error=>{throw Error(`Unexpected generic worker error: ${JSON.stringify(error)}`);},
  97  |   });
  98  |   // The real runtime retries an idle claim. Full main polls can briefly hold the
  99  |   // run lock, and claim deliberately uses SKIP LOCKED instead of blocking them.
  100 |   const executeWhenAvailable=async()=>{
  101 |     const deadline=Date.now()+5000;let idleClaims=0;
  102 |     while(true){
  103 |       const outcome=await execute();if(outcome!=='idle')return outcome;
  104 |       const current=await state(f);
  105 |       expect(current,'An idle claim may only retry while the original job is still queued').toMatchObject({state:'queued',job_state:'queued'});
  106 |       idleClaims++;expect(Date.now(),`Timed out waiting for an unlocked queued run after ${idleClaims} idle claims`).toBeLessThan(deadline);
  107 |       await new Promise(resolve=>setTimeout(resolve,25));
  108 |     }
  109 |   };
  110 |   let active:ReturnType<typeof execute>|undefined;
  111 |   try{
  112 |     await page.goto(real.baseURL+f.route);await expect(page.locator('#pause-run')).toBeVisible();
  113 |     active=executeWhenAvailable();void active.catch(()=>{});
  114 |     await expect.poll(async()=>(await starts()).length,{timeout:15000}).toBe(1);
  115 |     const started=await state(f);expect(started).toMatchObject({id:f.runId,state:'running',job_id:f.jobId,job_state:'running',user_pause_requested:false,input_revision:1,input_hash:f.hash});
  116 |     expect(started.lease_token).not.toBeNull();expect(started.lease_until).not.toBeNull();
  117 |     const inFlight=await durable(f);expect(inFlight.attempts).toHaveLength(1);expect(inFlight.results).toHaveLength(0);expect(inFlight.observations).toHaveLength(0);
  118 |     await page.reload();await expect(page.locator('#pause-run')).toBeVisible();
  119 |     const pauseResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/runs/${f.runId}/pause`);
  120 |     await page.locator('#pause-run').click();const pause=await pauseResponse;expect(pause.status()).toBe(200);expect(pause.request().headers()['x-bb-csrf']).toBe(real.csrf);
  121 |     expect(await pause.json()).toMatchObject({run_id:f.runId,state:'running'});
  122 |     const requested=await state(f);expect(requested).toMatchObject({state:'running',job_state:'running',user_pause_requested:true,lease_token:started.lease_token});
  123 |     expect(requested.lease_until).not.toBeNull();expect(following).toBe(0);
  124 |     const blocked=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`) as RunSupplementDraftResponse;
  125 |     expect(blocked).toMatchObject({run_id:f.runId,revision:0,adopted:false,can_save:false});expect(blocked.blocked_reason).toContain('等待已有工作保存完毕');
  126 |     const rejected=await fetch(`${real.baseURL}/api/v1/runs/${f.runId}/supplement-draft`,{method:'PUT',headers:{...real.headers,'content-type':'application/json'},
  127 |       body:JSON.stringify({request_id:randomUUID(),expected_revision:0,base_input_revision:1,base_input_hash:f.hash,changes:[]})});
  128 |     expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({code:'INPUT_REVISION_CONFLICT'});
  129 |     expect((await real.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1',[f.runId])).rows[0].n).toBe(0);
  130 |     expect(await durable(f)).toEqual(inFlight);
  131 |     await page.screenshot({path:join(real.artifactRoot,'m1-inflight-pause-pending-viewport.png')});
  132 | 
  133 |     await writeFile(releasePath,'release-synthetic-result',{mode:0o600});expect(await active).toBe('paused');active=undefined;
  134 |     const paused=await state(f);expect(paused).toMatchObject({id:f.runId,state:'paused',stage:'user_paused',job_id:f.jobId,job_state:'paused',job_stage:'user_paused',user_pause_requested:true,lease_token:null,lease_until:null});
  135 |     expect(paused.checkpoint.stages?.model_generation).toMatchObject({logical_call_id:logicalCallId});expect(following).toBe(0);
  136 |     const savedCall=await durable(f);for(const key of ['attempts','observations','runtime','results','prompts'])expect(savedCall[key],key).toHaveLength(1);
  137 |     expect(savedCall.attempts![0]).toMatchObject({job_id:f.jobId,logical_call_id:logicalCallId,attempt_no:1,status:'completed',usage_status:'measured'});
  138 |     expect(savedCall.observations![0]).toMatchObject({outcome:'completed',input_tokens:12,output_tokens:4});
  139 |     expect(savedCall.runtime![0]).toMatchObject({adapter:'codex_exec',error_code:null,exit_code:0});
  140 |     const result=savedCall.results![0]!,resultBytes=await real.blobs.get(String(result.result_ref));
  141 |     expect(digest(resultBytes)).toBe(String(result.result_sha256).trim());expect(resultBytes.length).toBe(Number(result.byte_size));expect(JSON.parse(resultBytes.toString('utf8'))).toEqual(expectedResult);
  142 |     expect(paused.checkpoint.provider_results).toEqual([expect.objectContaining({logical_call_id:logicalCallId,attempt_no:1,result_ref:result.result_ref,result_sha256:String(result.result_sha256).trim()})]);
  143 |     expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`)).toMatchObject({can_save:true,revision:0,adopted:false});
  144 | 
  145 |     await page.reload();const panel=await ready(page,f);await panel.locator('[data-supplement-intent]').selectOption('');await panel.locator('[data-supplement-role]').selectOption('audit');
  146 |     const uploadResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname));
  147 |     const supplementalBytes=Buffer.from('SYNTHETIC preparation after a real adapter checkpoint; not adopted.');
  148 |     await panel.locator('[data-supplement-file]').setInputFiles({name:'synthetic-after-inflight.txt',mimeType:'text/plain',buffer:supplementalBytes});
  149 |     const uploaded=await uploadResponse;expect(uploaded.status()).toBe(200);const material=await uploaded.json();await real.verifyBytes({projectId:f.projectId},material,supplementalBytes);
  150 |     await expect(action(panel,'save')).toBeEnabled();const beforeSave=await evidence(f);
  151 |     expect(beforeSave.creditEvents.length).toBeGreaterThan(0);expect(beforeSave.outbox.length).toBeGreaterThan(0);expect(beforeSave.ownerJobs.length).toBeGreaterThan(0);
  152 |     const savedResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
  153 |     await action(panel,'save').click();const saved=await savedResponse;expect(saved.status()).toBe(200);expect(saved.request().headers()['x-bb-csrf']).toBe(real.csrf);
  154 |     const receipt=await saved.json() as RunSupplementDraftResponse;expect(receipt).toMatchObject({run_id:f.runId,revision:1,adopted:false,
  155 |       saved_work:{status:'captured',result_count:1},changes:[{replaces:null,material:{material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}}]});
  156 |     expect(receipt.saved_work.stage_count).toBeGreaterThanOrEqual(1);
  157 |     const frozenWork=(await real.pool.query(`SELECT w.*,c.attempt_id,c.result_id FROM bb_run_supplement_saved_work w
  158 |       JOIN bb_run_supplement_saved_results c ON c.run_id=w.run_id AND c.supplement_revision=w.supplement_revision
  159 |       WHERE w.run_id=$1 AND w.supplement_revision=1`,[f.runId])).rows;
  160 |     expect(frozenWork).toHaveLength(1);expect(frozenWork[0]).toMatchObject({execution_version:1,input_revision:1,input_hash:f.hash,
  161 |       job_id:f.jobId,source_checkpoint:paused.checkpoint,attempt_id:savedCall.attempts![0]!.id,result_id:result.id});
  162 |     expect(JSON.stringify(receipt)).not.toContain(String(result.result_ref));expect(JSON.stringify(receipt)).not.toContain(String(result.id));
  163 |     await expect(panel).toContainText('已保存工作记录');
  164 |     await expect(panel).toContainText('草稿已保存');const afterSave=await evidence(f);samePreparationOnly(f,beforeSave,afterSave,receipt);expect(await durable(f)).toEqual(savedCall);
  165 |     await page.reload();const restored=await ready(page,f);await expect(restored).toContainText('synthetic-after-inflight.txt');await expect(restored).toContainText('尚未采用');await expect(action(restored,'save')).toBeDisabled();
  166 |     await restored.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  167 |     await page.screenshot({path:join(real.artifactRoot,'m1-inflight-saved-viewport.png')});await page.screenshot({path:join(real.artifactRoot,'m1-inflight-saved-full.png'),fullPage:true});
  168 | 
  169 |     await page.locator('#resume-run').click();const dialog=page.locator('.run-supplement-resume-dialog');await expect(dialog).toBeVisible();await expect(dialog).toContainText('原材料');
  170 |     const resumeResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/v1/runs/${f.runId}/resume`);
  171 |     await dialog.locator('[data-supplement-resume-confirm]').click();expect((await resumeResponse).status()).toBe(200);
  172 |     const resumed=await state(f);expect(resumed).toMatchObject({id:f.runId,state:'queued',job_id:f.jobId,job_state:'queued',user_pause_requested:false,input_revision:1,input_hash:f.hash,execution_request_id:started.execution_request_id});
  173 |     expect(resumed.checkpoint).toEqual(paused.checkpoint);expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`)).toMatchObject({revision:1,adopted:false,can_save:false});
  174 |     const resumedEvidence=await evidence(f),identities=(rows:Row[])=>rows.map(({id,run_id})=>({id,run_id}));expect(identities(resumedEvidence.ownerJobs)).toEqual(identities(afterSave.ownerJobs));
  175 |     active=executeWhenAvailable();void active.catch(()=>{});expect(await active).toBe('paused');active=undefined;
  176 |     expect(following).toBe(1);expect(await starts()).toHaveLength(1);expect(await durable(f)).toEqual(savedCall);
  177 |     const replayed=await state(f);expect(replayed).toMatchObject({id:f.runId,job_id:f.jobId,state:'paused',stage:'capability_not_ready',input_revision:1,input_hash:f.hash,execution_request_id:started.execution_request_id});
  178 |     expect(replayed.checkpoint.stages?.model_generation).toEqual(paused.checkpoint.stages?.model_generation);expect(replayed.checkpoint.provider_results).toEqual(paused.checkpoint.provider_results);
  179 |     const finalEvidence=await evidence(f);expect(identities(finalEvidence.ownerJobs)).toEqual(identities(afterSave.ownerJobs));
  180 |     for(const key of ['input','creditEvents','reservations','lots','creditAccount','balance'])expect(finalEvidence[key],key).toEqual(initial[key]);
  181 |     expect(await real.blobs.get(String(result.result_ref))).toEqual(resultBytes);
> 182 |     const exactReceipt=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft?request_id=${receipt.request_id}`);expect(exactReceipt).toMatchObject({request_id:receipt.request_id,revision:1,adopted:false,
      |                                                                                                                                                   ^ Error: expect(received).toMatchObject(expected)
  183 |       saved_work:{status:'stale_boundary',result_count:1}});
  184 |     await writeFile(join(real.artifactRoot,'m1-inflight-assertions.json'),JSON.stringify({synthetic:true,full_main:true,
  185 |       scope:'Generic worker mechanics with a controlled local Codex subprocess, real durable journal and private disk bytes. Seeded original run; no business execution, supplier, Azure, adoption, surcharge or Word acceptance.',
  186 |       started,requested,blocked,paused,savedCall,receipt,frozenWork,beforeSave,afterSave,resumed,replayed,finalEvidence,adapterStarts:await starts()},null,2));
  187 |   }finally{
  188 |     stop.abort();await writeFile(releasePath,'release-synthetic-result',{mode:0o600}).catch(()=>{});await active?.catch(()=>{});
  189 |   }
  190 | });
  191 | 
```