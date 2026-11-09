import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {test,expect,browserApi,createSyntheticProject,fillSourceInformation,openProject,uploadFromPicker,localSql,type Audit} from './local-prelaunch-helpers';
import {billingLedger,integer} from './local-prelaunch-billing-helpers';
import {asUploadFile,createLocalPrelaunchBasicFixtures} from './local-prelaunch-fixtures';
import type {Page} from '@playwright/test';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_REAL_MODEL!=='1','Explicit local full stack and real supplier opt-in required.');
test.use({viewport:{width:1440,height:1000}});
test.setTimeout(1800000);

async function channel(page:Page,path:string,input:unknown){
  return page.evaluate(async({path,input})=>{
    const csrf=document.cookie.split('; ').find(c=>c.startsWith('bb_csrf='))?.slice(8)??'';
    const response=await fetch('/__billing-test/api/'+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-bb-csrf':csrf},body:JSON.stringify(input)});
    return {status:response.status,body:await response.json()};
  },{path,input});
}
async function fund(page:Page,audit:Audit,amount='100000'){
  const created=await browserApi(page,'POST','/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen:amount,provider:'wechat'});
  expect(created.status,JSON.stringify(created.body)).toBe(201);audit.record('real-topup-order',created.body);
  const paid=await channel(page,'payment/outcome',{id:created.body.order_id,outcome:'paid',delivery:'query'});
  expect(paid.status).toBe(200);
  const refreshed=await browserApi(page,'POST',`/api/v1/commerce/topups/${created.body.order_id}/refresh`,{});
  expect(refreshed.status).toBe(200);expect(refreshed.body.state).toBe('paid');
  return audit.checkpoint('verified-topup-funded-before-generation');
}
async function startFromPage(page:Page,audit:Audit){
  await expect(page.locator('#execute-input')).toBeEnabled();
  const submitted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/runs/execute',{timeout:60000});
  await page.locator('#execute-input').click();
  const response=await submitted,run=await response.json();
  audit.record('real-browser-submission',{status:response.status(),request:response.request().postDataJSON(),run});
  expect(response.ok(),JSON.stringify(run)).toBe(true);
  const request=response.request().postDataJSON();
  const initialCharge=await browserApi(page,'GET',`/api/v1/runs/${run.run_id}/credit-charge`);
  expect(initialCharge.status).toBe(200);expect(initialCharge.body.quote.quote_id).toBe(request.quote_id);
  audit.record('original-run-locked-quote',initialCharge.body.quote);
  const replay=await browserApi(page,'POST','/api/v1/runs/execute',request);
  expect(replay.status).toBe(202);expect(replay.body.run_id).toBe(run.run_id);
  audit.checkpoint('repeated-submit-reused-run',replay);
  await page.reload();
  let terminal:any,last='';
  await expect.poll(async()=>{
    const result=await browserApi(page,'GET',`/api/v1/runs/${run.run_id}`);expect(result.status).toBe(200);terminal=result.body;
    if(last!==`${terminal.state}/${terminal.stage}`){last=`${terminal.state}/${terminal.stage}`;audit.record('real-worker-state',terminal);console.log(`${run.run_id} ${last}`);}
    return ['succeeded','failed','cancelled','rejected','paused'].includes(terminal.state);
  },{timeout:1500000,intervals:[2000,5000,10000]}).toBe(true);
  return {terminal,request,quote:initialCharge.body.quote};
}
// Independent ZIP extraction of delivered bytes. This is a content assertion, not the product availability validator.
function documentXml(bytes:Buffer):string{
  for(let offset=0;offset+46<bytes.length;offset++){
    if(bytes.readUInt32LE(offset)!==0x02014b50)continue;
    const nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32);
    const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');
    if(name==='word/document.xml'){
      const local=bytes.readUInt32LE(offset+42),size=bytes.readUInt32LE(offset+20),method=bytes.readUInt16LE(offset+10);
      const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28),part=bytes.subarray(start,start+size);
      return (method===0?part:inflateRawSync(part)).toString('utf8');
    }
    offset+=45+nameLength+extraLength+commentLength;
  }
  throw Error('Delivered Word has no document.xml');
}

const instruction='【纯合成验收】只对本原稿做最小修订：把原稿报告期2025年度改为2026年1—9月，并保留SYNTHETIC声明和唯一测试标记。保留原稿全部其他内容及格式，不扩写完整募集书，不虚构财务数据或发行条款，交付修订版与清洁版。';
async function saveInstruction(page:Page){
  await page.getByLabel('补充募集书更新说明',{exact:true}).fill(instruction);
  await page.getByLabel('补充募集书更新说明',{exact:true}).blur();
  await expect(page.locator('#conversation-status')).toContainText(/已自动保存|已保存/);
}
async function verifyDelivery(page:Page,audit:Audit,terminal:any,marker:string,prefix=''){
  const artifact=await browserApi(page,'GET',`/api/v1/artifacts/${terminal.artifact_id}`);
  expect(artifact.status).toBe(200);expect(artifact.body.run_id).toBe(terminal.run_id);
  await page.goto(`/#/artifacts/${terminal.artifact_id}`);
  const files=[];
  for(const [label,name,id] of [
    ['下载修订版','tracked.docx',artifact.body.word_delivery.revision_artifact_id],
    ['下载清洁版','clean.docx',artifact.body.word_delivery.clean_artifact_id],
  ] as const){
    const descriptor=await browserApi(page,'GET',`/api/v1/artifacts/${id}`);expect(descriptor.status).toBe(200);
    expect(descriptor.body.run_id).toBe(terminal.run_id);
    await expect(page.getByRole('button',{name:label,exact:true})).toBeVisible();
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();
    const path=join(audit.directory,prefix+name);await(await downloading).saveAs(path);
    const bytes=readFileSync(path),xml=documentXml(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(descriptor.body.sha256);expect(bytes.length).toBeGreaterThan(1000);
    expect(xml).toContain(marker);expect(xml).toContain('SYNTHETIC');
    if(name==='clean.docx'){
      const visible=xml.replace(/<[^>]+>/g,'');expect(visible).toContain('2026');
      expect(visible).not.toContain('原稿报告期：2025年度');expect(xml).not.toContain('<w:del');
    }
    files.push({name:prefix+name,bytes:bytes.length,sha256,markerPresent:true,syntheticLabelPresent:true});
  }
  audit.record('delivered-output-independent-content-check',files);
}
async function verifySettlement(page:Page,audit:Audit,runId:string,quote:any){
  const charge=await browserApi(page,'GET',`/api/v1/runs/${runId}/credit-charge`);expect(charge.status).toBe(200);
  expect(charge.body.quote).toEqual(quote);expect(charge.body.state).toBe('settled');
  expect(charge.body.progress).toMatchObject({policy:'on_delivery',charged_points:quote.points,released_points:'0'});
  const ledger=billingLedger(audit.owner),reservation=ledger.reservations.filter((r:any)=>r.run_id===runId);
  expect(reservation).toHaveLength(1);expect(reservation[0]).toMatchObject({state:'settled',billing_policy:'on_delivery',points:quote.points,charged_points:quote.points});
  const events=ledger.events.filter((e:any)=>e.run_id===runId);
  for(const kind of ['reserve','settle']){
    const rows=events.filter((e:any)=>e.kind===kind);expect(rows).toHaveLength(1);expect(rows[0].points).toBe(quote.points);
  }
  expect(events.filter((e:any)=>e.kind==='release')).toHaveLength(0);
  const calls=ledger.modelCalls.filter((c:any)=>c.run_id===runId);expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({status:'completed',model_id:'gpt-6-sol',usage_status:'measured'});
  audit.record('actual-quote-and-exactly-once-settlement',{charge,ledger});return ledger;
}

test('real queued authoring survives browser refresh and delivers source-based Word with exactly one settlement',async({page,audit})=>{
  const marker='real_'+randomUUID().slice(0,8),fixtures=createLocalPrelaunchBasicFixtures({marker});
  const project=await createSyntheticProject(page,marker);await openProject(page,project.project_id);
  await page.locator('#prospectus-panel').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(audit.directory,'reference-empty-1440.png')});
  const source=await uploadFromPicker(page,project.project_id,asUploadFile(fixtures.normalDocx),true);
  await fillSourceInformation(page,source.material_id);
  await page.locator('#prospectus-panel').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(audit.directory,'reference-adopted-1440.png')});
  await saveInstruction(page);
  const funded=await fund(page,audit);
  const {terminal,request,quote}=await startFromPage(page,audit);
  audit.checkpoint('real-authoring-terminal',terminal);expect(terminal.state,JSON.stringify(terminal)).toBe('succeeded');expect(terminal.artifact_id).toBeTruthy();
  await verifySettlement(page,audit,terminal.run_id,quote);
  await verifyDelivery(page,audit,terminal,marker);
  const beforeReplay=audit.checkpoint('verified-delivery');
  const duplicate=await browserApi(page,'POST','/api/v1/runs/execute',request);expect(duplicate.status).toBe(202);expect(duplicate.body.run_id).toBe(terminal.run_id);
  const afterReplay=audit.checkpoint('terminal-replay-no-recharge-no-new-model');
  expect(afterReplay.runs).toBe(funded.runs+1);expect(afterReplay.modelCalls).toBeGreaterThan(funded.modelCalls);
  expect(afterReplay.frozen).toBe(funded.frozen);expect(integer(funded.remaining)-integer(afterReplay.remaining)).toBe(integer(quote.points));
  for(const field of ['runs','creditEvents','reservations','modelCalls','remaining','frozen'] as const)expect(afterReplay[field]).toBe(beforeReplay[field]);
});

test('corrupt adopted DOCX releases credits without model use then corrected source delivers a new immutable round',async({page,audit})=>{
  const marker='bad_'+randomUUID().slice(0,8),fixtures=createLocalPrelaunchBasicFixtures({marker});
  const project=await createSyntheticProject(page,marker);await openProject(page,project.project_id);
  const source=await uploadFromPicker(page,project.project_id,asUploadFile(fixtures.truncatedDocx),true);
  await fillSourceInformation(page,source.material_id);
  const funded=await fund(page,audit);
  const {terminal,request,quote}=await startFromPage(page,audit);audit.checkpoint('corrupt-reference-real-terminal',terminal);
  expect(terminal.state,JSON.stringify(terminal)).toBe('failed');expect(terminal.artifact_id).toBeFalsy();
  const failed=audit.checkpoint('corrupt-reference-wallet-restored');expect(failed.remaining).toBe(funded.remaining);expect(failed.frozen).toBe(funded.frozen);
  expect(failed.modelCalls).toBe(funded.modelCalls);
  const events=await browserApi(page,'GET',`/api/v1/runs/${terminal.run_id}/events`);expect(events.status).toBe(200);
  expect(events.body.items.at(-1)?.seq).toBe(terminal.event_cursor);
  expect(events.body.next_cursor).toBe(terminal.event_cursor);
  const eventTail=await browserApi(page,'GET',`/api/v1/runs/${terminal.run_id}/events?after=${events.body.next_cursor}`);
  expect(eventTail.status).toBe(200);
  expect(eventTail.body).toEqual({items:[],next_cursor:terminal.event_cursor});
  expect(events.body.items.at(-1)).toMatchObject({state:'failed',payload:{reason:'processor_failed',error_code:'MATERIAL_UNREADABLE'}});
  expect(events.body.items.some((e:any)=>e.payload.reason==='lease_recovered')).toBe(false);
  const attempts=localSql<{attempts:number}>(`SELECT json_build_object('attempts',attempts) FROM bb_jobs WHERE run_id='${terminal.run_id}' AND owner_user_id='${audit.owner}';`);
  expect(attempts.attempts).toBe(1);
  const failedLedger=billingLedger(audit.owner),failedReservation=failedLedger.reservations.find((r:any)=>r.run_id===terminal.run_id);
  expect(failedReservation).toMatchObject({state:'released',billing_policy:'on_delivery',points:quote.points,charged_points:'0'});
  for(const kind of ['reserve','release']){
    const rows=failedLedger.events.filter((e:any)=>e.run_id===terminal.run_id&&e.kind===kind);expect(rows).toHaveLength(1);expect(rows[0].points).toBe(quote.points);
  }
  expect(failedLedger.events.filter((e:any)=>e.kind==='settle')).toHaveLength(0);
  audit.record('confirmed-unreadable-no-model-single-release',{events:events.body,attempts,failedLedger});
  await page.goto(`/#/projects/${project.project_id}?run=${terminal.run_id}`);
  await expect(page.locator('.execution-summary')).toContainText('有材料无法读取');
  await expect(page.locator('.execution-summary')).toContainText('点击“继续修改”');
  await page.screenshot({path:join(audit.directory,'unreadable-source-actionable.png'),fullPage:true});
  await page.locator('#execution-progress').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(audit.directory,'unreadable-source-actionable-1440.png')});
  const replay=await browserApi(page,'POST','/api/v1/runs/execute',request);expect(replay.status).toBe(202);expect(replay.body.run_id).toBe(terminal.run_id);
  const after=audit.checkpoint('failed-replay-no-repeat-fee');
  for(const field of ['runs','creditEvents','reservations','modelCalls','remaining','frozen'] as const)expect(after[field]).toBe(failed[field]);
  await page.locator('#prepare-next-version').click();
  const corrected=await uploadFromPicker(page,project.project_id,asUploadFile(fixtures.normalDocx),true);
  expect(corrected.material_id).not.toBe(source.material_id);await fillSourceInformation(page,corrected.material_id);await saveInstruction(page);
  const recovered=await startFromPage(page,audit);
  expect(recovered.terminal.state,JSON.stringify(recovered.terminal)).toBe('succeeded');
  expect(recovered.terminal.run_id).not.toBe(terminal.run_id);expect(recovered.request.input_revision).toBeGreaterThan(request.input_revision);
  expect(recovered.request.input_hash).not.toBe(request.input_hash);expect(recovered.request.execution_request_id).not.toBe(request.execution_request_id);
  const settled=await verifySettlement(page,audit,recovered.terminal.run_id,recovered.quote);
  expect(settled.runs).toHaveLength(2);expect(settled.reservations).toHaveLength(2);
  expect(settled.runs.find((r:any)=>r.id===terminal.run_id)).toEqual(failedLedger.runs.find((r:any)=>r.id===terminal.run_id));
  expect(settled.reservations.find((r:any)=>r.run_id===terminal.run_id)).toEqual(failedReservation);
  expect(settled.events.filter((e:any)=>e.run_id===terminal.run_id)).toEqual(failedLedger.events.filter((e:any)=>e.run_id===terminal.run_id));
  await verifyDelivery(page,audit,recovered.terminal,marker,'corrected-');
  const oldReplay=await browserApi(page,'POST','/api/v1/runs/execute',request);expect(oldReplay.status).toBe(202);expect(oldReplay.body.run_id).toBe(terminal.run_id);
  const newReplay=await browserApi(page,'POST','/api/v1/runs/execute',recovered.request);expect(newReplay.status).toBe(202);expect(newReplay.body.run_id).toBe(recovered.terminal.run_id);
  expect(billingLedger(audit.owner)).toEqual(settled);audit.record('corrected-source-new-round-old-failure-preserved',settled);
});
