import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {LEGACY_BILLING_WIRE_VERSION,PROJECT_QA_PRICE} from '@bondbuddy/contracts';
import {test,expect,billingApi,channelState,accountAmounts,integer,topupApi,payViaQuery,billingLedger} from './local-prelaunch-billing-helpers';
import {prepareBillingQa,waitForQa} from './local-prelaunch-billing-worker-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1','Requires the explicitly owned local full-stack acceptance environment.');
test.setTimeout(900000);
test('billing06 actual model QA zero funds UI payment resumes same request and settles once',async({page,billing})=>{
  test.skip(process.env.BB_E2E_REAL_MODEL!=='1','Root must authorize the shared real-model execution window.');
  const setup=await prepareBillingQa(page,billing),path=`/api/v1/projects/${setup.project}/qa/runs`,before=billing.checkpoint('free-prepare-before-zero-balance-answer');expect(before.modelCalls).toEqual([]);expect(before.events).toEqual([]);
  await page.goto(`/#qa?project=${setup.project}`);await expect(page.locator('#qa-start')).toBeEnabled();
  const rejectedResponse=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');await page.locator('#qa-start').click();const rejected=await rejectedResponse;expect(rejected.status(),await rejected.text()).toBe(402);
  const original=rejected.request().postDataJSON();expect(typeof original.expected_points).toBe('string');const points=integer(original.expected_points);expect(points).toBeGreaterThan(0n);billing.record('real-zero-balance-request-rejected',{path,body:original,status:rejected.status()});expect(billing.checkpoint('zero-balance-answer-admission-rolled-back')).toEqual(before);
  const oldNew=await billingApi(page,'POST',path,{...original,expected_points:Number(points)},undefined,LEGACY_BILLING_WIRE_VERSION);expect(oldNew.status).toBe(409);expect(oldNew.body.code).toBe('BILLING_PROTOCOL_REPLAY_ONLY');
  const stale=await billingApi(page,'POST',path,{...original,request_id:randomUUID(),price_version:PROJECT_QA_PRICE.version});expect(stale.status).toBe(409);expect(stale.body.code).toBe('QUOTE_CHANGED');billing.record('legacy-new-task-and-stale-price-refused-before-run',{oldNew,stale,legacyPriceVersion:PROJECT_QA_PRICE.version});expect(billing.checkpoint('old-price-requests-create-no-run-or-debit')).toEqual(before);
  await page.getByRole('link',{name:'订阅或充值，继续原任务',exact:true}).click();await expect(page).toHaveURL(/resume_request=/);
  await page.locator('#subscription-topup-amount').fill((points/100n)+'.'+String(points%100n).padStart(2,'0'));
  const recharge=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/commerce/topups'&&r.request().method()==='POST');await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();const rechargeResponse=await recharge;expect(rechargeResponse.status()).toBe(201);const order=await rechargeResponse.json();expect(order.amount_fen).toBe(points.toString());
  await page.getByRole('link',{name:'打开模拟收银台',exact:true}).click();await page.locator('#delivery').selectOption('callback');await page.locator('#simulate-paid').click();await expect(page.locator('#checkout-title')).toHaveText('积分已到账');
  const resumedResponse=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST'&&r.status()===200);await page.locator('#return-paid').click();const resumed=await resumedResponse;expect(resumed.request().postDataJSON()).toEqual(original);const accepted=await resumed.json();billing.record('product-payment-return-resumes-exact-original-request',{order,original,accepted});
  const completed=await waitForQa(page,setup.project,accepted.run_id);expect(completed.state,JSON.stringify(completed)).toBe('succeeded');expect(completed.manifest.prospectus.asset.pin.sha256).toBe(setup.reference.pin.sha256);expect(completed.result.answers).toHaveLength(1);expect(completed.result.answers[0].answer.trim().length).toBeGreaterThan(0);expect(completed.artifact_id).toBeTruthy();
  accountAmounts(await channelState(page,billing.owner),0n);const settled=billing.checkpoint('real-model-Word-delivery-settles-once');
  const reservation=settled.reservations.find((r:any)=>r.run_id===accepted.run_id);expect(reservation.state).toBe('settled');expect(reservation.points).toBe(points.toString());expect(reservation.charged_points).toBe(points.toString());
  const allocations=settled.allocations.filter((a:any)=>a.reservation_id===reservation.id);expect(allocations.reduce((sum:bigint,a:any)=>sum+integer(a.charged_points),0n)).toBe(points);
  const calls=settled.modelCalls.filter((a:any)=>a.run_id===accepted.run_id);expect(calls.some((a:any)=>a.status==='completed'&&a.model_id==='gpt-6-sol')).toBe(true);
  const artifact=await billingApi(page,'GET',`/api/v1/artifacts/${completed.artifact_id}`);expect(artifact.status).toBe(200);expect(artifact.body.run_id).toBe(accepted.run_id);
  await page.goto(`/#qa?project=${setup.project}&run=${accepted.run_id}`);const downloaded=page.waitForEvent('download');await page.locator('#qa-download').click();const download=await downloaded,file=billing.directory+'/actual-model-qa-answer.docx';await download.saveAs(file);const bytes=readFileSync(file);expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.body.sha256);expect(bytes.subarray(0,2).toString()).toBe('PK');billing.record('authorized-real-Word-download',{artifact:artifact.body,byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),modelCalls:calls,result:completed.result});
  for(let i=0;i<3;i++){const replay=await billingApi(page,'POST',path,original);expect(replay.status).toBe(200);expect(replay.body.run_id).toBe(accepted.run_id);}expect(billing.checkpoint('successful-task-replays-no-model-or-charge')).toEqual(settled);
  const legacyReplay=await billingApi(page,'POST',path,{...original,expected_points:Number(points)},undefined,LEGACY_BILLING_WIRE_VERSION);expect(legacyReplay.status).toBe(200);expect(legacyReplay.body.run_id).toBe(accepted.run_id);expect(billing.checkpoint('old-numeric-task-replay-keeps-original-price-and-model-result')).toEqual(settled);
});

test('billing07 actual worker rejects unreadable mandatory reference and releases reservation once',async({page,billing})=>{
  const setup=await prepareBillingQa(page,billing,true),base=`/api/v1/projects/${setup.project}/qa`;
  const quote=await billingApi(page,'POST',base+'/quote',{expected_revision:setup.revision});expect(quote.status,JSON.stringify(quote.body)).toBe(200);expect(quote.body.quote_status).toBe('ready');const points=integer(quote.body.points);expect(points).toBeGreaterThan(0n);
  const {order}=await topupApi(page,points.toString());await payViaQuery(page,billing.owner,order.order_id);const funded=billing.checkpoint('paid-exact-amount-before-unreadable-reference');accountAmounts(await channelState(page,billing.owner),points);
  const request={request_id:randomUUID(),expected_revision:setup.revision,expected_points:quote.body.points,price_version:quote.body.price_version,scope_quote_id:quote.body.scope_quote_id};
  const started=await billingApi(page,'POST',base+'/runs',request);expect(started.status,JSON.stringify(started.body)).toBe(200);const failed=await waitForQa(page,setup.project,started.body.run_id,120000);expect(failed.state,JSON.stringify(failed)).toBe('failed');expect(failed.error_code).toBe('MATERIAL_UNREADABLE');expect(failed.artifact_id).toBeNull();
  const released=billing.checkpoint('real-worker-unreadable-failure-releases-precise-reservation');expect(released.lots).toEqual(funded.lots);expect(released.modelCalls).toEqual(funded.modelCalls);accountAmounts(await channelState(page,billing.owner),points);
  const reservation=released.reservations.find((r:any)=>r.run_id===started.body.run_id);expect(reservation.state).toBe('released');expect(reservation.points).toBe(points.toString());expect(reservation.charged_points).toBe('0');
  expect(released.events.filter((e:any)=>e.run_id===started.body.run_id&&e.kind==='reserve')).toHaveLength(1);expect(released.events.filter((e:any)=>e.run_id===started.body.run_id&&e.kind==='release')).toHaveLength(1);expect(released.events.filter((e:any)=>e.run_id===started.body.run_id&&e.kind==='settle')).toHaveLength(0);
  for(let i=0;i<3;i++){const replay=await billingApi(page,'POST',base+'/runs',request);expect(replay.status).toBe(200);expect(replay.body.run_id).toBe(started.body.run_id);}expect(billing.checkpoint('failed-task-replays-no-extra-refund-or-model')).toEqual(released);
  await page.goto(`/#qa?project=${setup.project}&run=${started.body.run_id}`);await expect(page.locator('body')).toContainText('请补充可读取的募集说明书');await expect(page.locator('#qa-download')).toHaveCount(0);
});
