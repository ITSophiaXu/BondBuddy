import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Page} from '@playwright/test';
import {expect,browserApi,createSyntheticProject,openProject,uploadFromPicker,fillSourceInformation,localSql,type Audit} from './local-prelaunch-helpers';
import {billingApi,billingLedger,integer,topupApi,payViaQuery} from './local-prelaunch-billing-helpers';
import {createLocalPrelaunchBasicFixtures,asUploadFile} from './local-prelaunch-fixtures';
import {executionRequest} from '../src/execution-request';

export type LegacyPausePhase='before_model'|'after_model';
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;

/** Read durable identities and provider results. This helper has no SQL writes. */
export function legacySnapshot(owner:string,runId:string):any{
  const who=literal(owner),id=literal(runId);
  return localSql(`SELECT json_build_object(
    'identity',json_build_object('run_id',r.id,'project_id',r.project_id,'execution_request_id',r.execution_request_id,
      'input_revision',r.input_revision,'input_hash',trim(r.input_hash),'reservation_id',r.reservation_id,'job_id',j.id),
    'checkpoint_stages',COALESCE(j.checkpoint->'stages','{}'::jsonb),
    'quote',json_build_object('quote_id',q.id,'price_version',q.price_version,'pricing_mode',q.pricing_mode,
      'task_type',q.task_type,'points',q.points::text,'project_id',q.project_id,'input_revision',q.input_revision,'input_hash',trim(q.input_hash)),
    'calls',COALESCE((SELECT json_agg(json_build_object('id',a.id,'logical_call_id',a.logical_call_id,'attempt_no',a.attempt_no,
      'status',a.status,'model_id',a.model_id,'usage_status',a.usage_status) ORDER BY a.id)
      FROM bb_model_call_attempts a WHERE a.owner_user_id=r.owner_user_id AND a.job_id=j.id),'[]'::json),
    'results',COALESCE((SELECT json_agg(json_build_object('id',p.id,'attempt_id',p.attempt_id,'logical_call_id',p.logical_call_id,
      'attempt_no',p.attempt_no,'model_id',p.model_id,'result_sha256',trim(p.result_sha256),'result_schema_version',p.result_schema_version,
      'byte_size',p.byte_size::text) ORDER BY p.id) FROM bb_provider_result_refs p
      WHERE p.owner_user_id=r.owner_user_id AND p.run_id=r.id AND p.job_id=j.id),'[]'::json))
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
    JOIN bb_credit_reservations c ON c.run_id=r.id AND c.owner_user_id=r.owner_user_id
    JOIN bb_credit_quotes q ON q.id=c.quote_id AND q.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=${who} AND r.id=${id};`);
}

function expectOneCompletedModel(snapshot:any){
  expect(snapshot.calls).toHaveLength(1);
  expect(snapshot.calls[0]).toMatchObject({logical_call_id:'file-authoring-v1',attempt_no:1,status:'completed',model_id:'gpt-6-sol',usage_status:'measured'});
  expect(snapshot.results).toHaveLength(1);
  expect(snapshot.results[0]).toMatchObject({attempt_id:snapshot.calls[0].id,logical_call_id:'file-authoring-v1',attempt_no:1,model_id:'gpt-6-sol',result_schema_version:'codex-file-word-v1'});
  expect(snapshot.results[0].result_sha256).toMatch(/^[a-f0-9]{64}$/);
}

async function prepareLegacy(page:Page,audit:Audit,phase:LegacyPausePhase){
  // Same current binary with old policy flags, never an old binary/schema upgrade.
  const marker=`policy_${phase}_${randomUUID().slice(0,8)}`,fixtures=createLocalPrelaunchBasicFixtures({marker});
  const project=await createSyntheticProject(page,marker);await openProject(page,project.project_id);
  const source=await uploadFromPicker(page,project.project_id,asUploadFile(fixtures.normalDocx),true);
  await fillSourceInformation(page,source.material_id);
  await page.getByLabel('补充募集书更新说明',{exact:true}).fill('【纯合成验收】保留全部原稿内容与格式、SYNTHETIC标记及唯一标记，只把原稿报告期2025年度更新为2026年1—9月，不扩写完整募集书、不编造数据，交付修订版与清洁版。');
  await page.getByLabel('补充募集书更新说明',{exact:true}).blur();
  await expect(page.locator('#conversation-status')).toContainText(/已自动保存|已保存/);
  const current=await browserApi(page,'GET',`/api/v1/projects/${project.project_id}`);
  const versions=await browserApi(page,'GET',`/api/v1/projects/${project.project_id}/prospectus-versions`);
  const messages=await browserApi(page,'GET',`/api/v1/projects/${project.project_id}/messages?limit=20`);
  for(const result of [current,versions,messages])expect(result.status,JSON.stringify(result.body)).toBe(200);
  const ref=messages.body.project_message_set_ref;expect(ref.message_ids.length).toBeGreaterThan(0);
  const locked=await browserApi(page,'POST',`/api/v1/projects/${project.project_id}/input-revisions`,{
    draft_revision:current.body.draft_revision,prospectus_selection_revision:versions.body.selection_revision,
    material_versions:[{material_id:source.material_id,material_version:source.material_version}],
    requirement_message_ids:ref.message_ids,project_message_set_ref:ref});
  expect(locked.status,JSON.stringify(locked.body)).toBe(201);
  const quote=await billingApi(page,'POST',`/__legacy/api/v1/projects/${project.project_id}/credit-quote`,{
    input_revision:locked.body.input_revision,input_hash:locked.body.input_hash});
  expect(quote.status,JSON.stringify(quote.body)).toBe(200);expect(quote.body.enabled).toBe(true);
  const points=integer(quote.body.quote.points);expect(points).toBeGreaterThan(1n);
  const initialPoints=phase==='before_model'?1n:points/10n;
  if(phase==='after_model'){
    // Actual milestones: materials_ready 400bps; model_generation 2000bps.
    // 10% funds preparation but cannot fund the model-completed boundary.
    // The saved stage/result assertions must prove the actual window was reached.
    expect(initialPoints).toBeGreaterThan(points*400n/10000n);
    expect(initialPoints).toBeLessThan(points*2000n/10000n);
  }
  audit.record('legacy-policy-quote-and-real-pause-budget',{phase,quote:quote.body,input:locked.body,initialPoints:initialPoints.toString(),milestones:{materials_ready_bps:400,model_generation_bps:2000}});
  const initial=await topupApi(page,initialPoints.toString());await payViaQuery(page,audit.owner,initial.order.order_id);
  const request={...await executionRequest(locked.body,'update'),quote_id:quote.body.quote.quote_id};
  const started=await billingApi(page,'POST','/__legacy/api/v1/runs/execute',request);
  expect(started.status,JSON.stringify(started.body)).toBe(202);
  return {project,locked:locked.body,quote:quote.body.quote,points,initialPoints,request,id:started.body.run_id as string};
}

async function waitForLegacy(page:Page,audit:Audit,id:string,label:string,includePaused:boolean){
  let terminal:any,last='';
  await expect.poll(async()=>{
    const result=await browserApi(page,'GET',`/api/v1/runs/${id}`);expect(result.status).toBe(200);terminal=result.body;
    const state=`${terminal.state}/${terminal.stage}`;
    if(last!==state){last=state;audit.record(label,terminal);console.log(`${id} ${state}`);}
    return ['failed','succeeded','cancelled','rejected',...(includePaused?['paused']:[])].includes(terminal.state);
  },{timeout:1500000,intervals:[2000,5000,10000]}).toBe(true);
  return terminal;
}

export async function exerciseLegacyRecovery(page:Page,audit:Audit,phase:LegacyPausePhase){
  const setup=await prepareLegacy(page,audit,phase),{id,points,initialPoints,quote,request,project}=setup;
  const paused=await waitForLegacy(page,audit,id,'legacy-real-worker-state',true);
  expect(paused.state,JSON.stringify(paused)).toBe('paused');expect(paused.stage).toBe('credits_exhausted');
  const before=billingLedger(audit.owner),held=before.reservations.find((r:any)=>r.run_id===id),saved=legacySnapshot(audit.owner,id);
  expect(held.billing_policy).toBe('authoring_balance_v2');expect(held.state).toBe('held');expect(held.points).toBe(points.toString());
  expect(held.charged_points).toBe(initialPoints.toString());expect(before.lots.reduce((n:bigint,l:any)=>n+integer(l.remaining),0n)).toBe(0n);
  expect(saved.identity).toMatchObject({run_id:id,project_id:project.project_id,execution_request_id:request.execution_request_id,
    input_revision:setup.locked.input_revision,input_hash:setup.locked.input_hash,reservation_id:held.id});
  expect(saved.quote).toMatchObject({quote_id:quote.quote_id,price_version:quote.price_version,points:points.toString(),pricing_mode:'legacy_credit',
    input_revision:setup.locked.input_revision,input_hash:setup.locked.input_hash});
  if(phase==='before_model'){
    expect(saved.calls).toHaveLength(0);expect(saved.results).toHaveLength(0);
    expect(saved.checkpoint_stages).not.toHaveProperty('model_generation');
  }else{
    expect(saved.checkpoint_stages).toHaveProperty('materials_ready');
    expect(saved.checkpoint_stages.model_generation).toMatchObject({logical_call_id:'file-authoring-v1'});
    expectOneCompletedModel(saved);
  }
  audit.record('actual-pause-phase-and-durable-model-checkpoint',{phase,ledger:before,saved});
  await page.goto(`/#/projects/${project.project_id}?run=${id}`);await expect(page.locator('body')).toContainText('任务已暂停');
  // The progress panel and its modal both offer recharge. Assert the active
  // user-facing modal and its exact original-task return target.
  const recharge=page.getByRole('dialog',{name:'积分已用完，充值后继续',exact:true}).getByRole('link',{name:'充值积分',exact:true});
  await expect(recharge).toBeVisible();
  const rechargeHref=await recharge.getAttribute('href');
  expect(rechargeHref).toBeTruthy();
  const rechargeParams=new URLSearchParams(rechargeHref!.slice(rechargeHref!.indexOf('?')+1));
  expect(rechargeParams.get('project')).toBe(project.project_id);
  expect(rechargeParams.get('return_to')).toBe(`#/projects/${project.project_id}?run=${id}&resume=credits`);
  const replay=await billingApi(page,'POST','/api/v1/runs/execute',request);expect(replay.status,JSON.stringify(replay.body)).toBe(202);expect(replay.body.run_id).toBe(id);
  expect(billingLedger(audit.owner)).toEqual(before);expect(legacySnapshot(audit.owner,id)).toEqual(saved);
  const oldCharge=await billingApi(page,'GET',`/api/v1/runs/${id}/credit-charge`);expect(oldCharge.status).toBe(200);
  expect(oldCharge.body.state).toBe('held');expect(oldCharge.body.quote).toEqual(quote);
  expect(oldCharge.body.progress).toMatchObject({policy:'authoring_balance_v2',charged_points:initialPoints.toString(),credit_exhausted:true,clock_running:false});
  const replenishment=await topupApi(page,points.toString());await payViaQuery(page,audit.owner,replenishment.order.order_id);
  const terminal=await waitForLegacy(page,audit,id,'current-worker-automatic-credit-recovery',false);
  expect(terminal.state,JSON.stringify(terminal)).toBe('succeeded');expect(terminal.artifact_id).toBeTruthy();
  const settled=billingLedger(audit.owner),reservation=settled.reservations.find((r:any)=>r.run_id===id),recovered=legacySnapshot(audit.owner,id);
  expect(recovered.identity).toEqual(saved.identity);expect(recovered.quote).toEqual(saved.quote);
  expectOneCompletedModel(recovered);
  if(phase==='after_model'){
    expect(recovered.calls).toEqual(saved.calls);expect(recovered.results).toEqual(saved.results);
    expect(recovered.checkpoint_stages.model_generation).toEqual(saved.checkpoint_stages.model_generation);
  }
  expect(reservation.id).toBe(held.id);expect(reservation.billing_policy).toBe('authoring_balance_v2');
  expect(reservation.state).toBe('settled');expect(reservation.points).toBe(points.toString());expect(reservation.charged_points).toBe(points.toString());
  const debits=settled.events.filter((e:any)=>e.run_id===id&&e.kind==='settle');
  expect(debits.reduce((n:bigint,e:any)=>n+integer(e.points),0n)).toBe(points);
  expect(new Set(debits.map((e:any)=>e.event_key)).size).toBe(debits.length);
  expect(settled.allocations.filter((a:any)=>a.reservation_id===held.id).reduce((n:bigint,a:any)=>n+integer(a.charged_points),0n)).toBe(points);
  expect(settled.runs).toHaveLength(1);expect(settled.reservations).toHaveLength(1);
  expect(settled.lots.reduce((n:bigint,l:any)=>n+integer(l.remaining),0n)).toBe(initialPoints);
  expect(settled.lots.reduce((n:bigint,l:any)=>n+integer(l.frozen),0n)).toBe(0n);
  const finalCharge=await billingApi(page,'GET',`/api/v1/runs/${id}/credit-charge`);expect(finalCharge.status).toBe(200);
  expect(finalCharge.body.state).toBe('settled');expect(finalCharge.body.quote).toEqual(quote);
  expect(finalCharge.body.progress).toMatchObject({policy:'authoring_balance_v2',charged_points:points.toString(),clock_running:false});
  audit.record('same-model-result-and-original-terminal-price',{phase,saved,recovered,oldCharge,finalCharge,ledger:settled});
  const artifact=await billingApi(page,'GET',`/api/v1/artifacts/${terminal.artifact_id}`);
  expect(artifact.status).toBe(200);expect(artifact.body.run_id).toBe(id);
  expect(artifact.body.word_delivery.revision_artifact_id).toBe(terminal.artifact_id);
  expect(artifact.body.word_delivery.clean_artifact_id).toBeTruthy();
  await page.goto(`/#/artifacts/${terminal.artifact_id}`);
  for(const [label,name] of [['下载修订版','legacy-tracked.docx'],['下载清洁版','legacy-clean.docx']] as const){
    const artifactId=name==='legacy-tracked.docx'?artifact.body.word_delivery.revision_artifact_id:artifact.body.word_delivery.clean_artifact_id;
    const descriptor=await billingApi(page,'GET',`/api/v1/artifacts/${artifactId}`);expect(descriptor.status).toBe(200);
    expect(descriptor.body.run_id).toBe(id);expect(descriptor.body.artifact_id).toBe(artifactId);
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();
    const file=join(audit.directory,name);await(await downloading).saveAs(file);const bytes=readFileSync(file);
    expect(bytes.length).toBeGreaterThan(1000);expect(bytes.subarray(0,2).toString()).toBe('PK');
    const sha256=createHash('sha256').update(bytes).digest('hex');expect(sha256).toBe(descriptor.body.sha256);
    audit.record('actual-recovered-Word-download',{name,artifactId,runId:id,bytes:bytes.length,sha256});
  }
  for(const path of ['/api/v1/runs/execute','/__legacy/api/v1/runs/execute']){
    const repeated=await billingApi(page,'POST',path,request);expect(repeated.status).toBe(202);expect(repeated.body.run_id).toBe(id);
  }
  expect(billingLedger(audit.owner)).toEqual(settled);expect(legacySnapshot(audit.owner,id)).toEqual(recovered);
  const chargeAfterReplay=await billingApi(page,'GET',`/api/v1/runs/${id}/credit-charge`);expect(chargeAfterReplay.status).toBe(200);
  expect(chargeAfterReplay.body.quote).toEqual(quote);expect(chargeAfterReplay.body.state).toBe('settled');
}
