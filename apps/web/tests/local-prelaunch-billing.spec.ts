import {randomUUID} from 'node:crypto';
import {LEGACY_BILLING_WIRE_VERSION} from '@bondbuddy/contracts';
import {test,expect,billingApi,billingLedger,fundsOnly,channelState,accountAmounts,integer,topupApi,topupUI,openCashier,payViaQuery,registerBillingAccount} from './local-prelaunch-billing-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1','Requires the explicitly owned local full-stack acceptance environment.');
test.setTimeout(120000);
test('billing01 invalid wire amounts never create payment or ledger records',async({page,billing})=>{
  const before=billing.checkpoint('before-invalid-topups');
  for(const amount_fen of ['0','-1','1.001','1000001',1]){
    const r=await billingApi(page,'POST','/api/v1/commerce/topups',{request_id:randomUUID(),amount_fen,provider:'wechat'});expect(r.status,JSON.stringify(r.body)).toBe(422);billing.record('rejected-topup',{amount_fen,...r});
  }
  expect(billing.checkpoint('after-rejected-topups')).toEqual(before);
  const {order}=await topupApi(page,'1');expect(order.amount_fen).toBe('1');expect(order.points).toBe('1');accountAmounts(await channelState(page,billing.owner),0n);
  expect((await billingApi(page,'POST','/__billing-test/api/payment/close',{id:order.order_id},billing.owner)).status).toBe(200);
  expect(fundsOnly(billing.checkpoint('valid-minimum-order-closed'))).toEqual(fundsOnly(before));
});

test('billing02 real UI unknown payment then query and repeated callback credit once',async({page,billing})=>{
  const {order,body}=await topupUI(page,'1.00');billing.record('original-ui-order',{order,body});
  await page.locator('#refresh-payment').click();await expect(page.locator('#checkout-title')).toHaveText('等待模拟支付');accountAmounts(await channelState(page,billing.owner),0n);
  const pending=billing.checkpoint('query-does-not-pay');expect(pending.events).toEqual([]);expect(pending.lots).toEqual([]);
  await page.locator('#simulate-paid').click();await expect(page.locator('#checkout-title')).toHaveText('渠道已支付，产品待核实入账');accountAmounts(await channelState(page,billing.owner),0n);
  await page.locator('#refresh-payment').click();await expect(page.locator('#checkout-title')).toHaveText('积分已到账');accountAmounts(await channelState(page,billing.owner),100n);
  const paid=billing.checkpoint('one-original-order-credited');expect(paid.orders).toHaveLength(1);expect(paid.lots).toHaveLength(1);expect(paid.lots[0].source_key).toBe('recharge:'+order.order_id);
  const repeats=await Promise.all(Array.from({length:6},()=>billingApi(page,'POST',`/api/v1/commerce/topups/${order.order_id}/refresh`,{})));
  repeats.forEach(r=>expect(r.status).toBe(200));
  for(let i=0;i<3;i++)expect((await billingApi(page,'POST','/__billing-test/api/payment/outcome',{id:order.order_id,outcome:'paid',delivery:'callback'},billing.owner)).status).toBe(200);
  const creates=await Promise.all(Array.from({length:4},()=>billingApi(page,'POST','/api/v1/commerce/topups',body)));creates.forEach(r=>{expect(r.status).toBe(201);expect(r.body.order_id).toBe(order.order_id);});
  expect((await billingApi(page,'POST','/api/v1/commerce/topups',{...body,amount_fen:'101'})).status).toBe(409);
  expect(billing.checkpoint('all-payment-replays-preserve-exact-ledger')).toEqual(paid);await page.reload();await expect(page.locator('#checkout-title')).toHaveText('积分已到账');await expect(page.locator('#simulate-paid')).toBeDisabled();
});

test('billing03 callback UI credits once while failed closed and forged payments issue nothing',async({page,billing})=>{
  const {order}=await topupUI(page,'2.00');await page.locator('#delivery').selectOption('callback');await page.locator('#simulate-paid').click();await expect(page.locator('#checkout-title')).toHaveText('积分已到账');accountAmounts(await channelState(page,billing.owner),200n);
  const credited=billing.checkpoint('authenticated-callback-credited');
  const failed=await topupApi(page,'50');await openCashier(page,failed.order.order_id);await page.locator('#simulate-failed').click();await page.locator('#refresh-payment').click();await expect(page.locator('#checkout-title')).toHaveText('支付未完成');
  expect((await billingApi(page,'POST','/__billing-test/api/payment/outcome',{id:failed.order.order_id,outcome:'paid',delivery:'callback'},billing.owner)).status).toBe(409);
  const closed=await topupApi(page,'70');await openCashier(page,closed.order.order_id);await page.locator('#close-payment').click();await expect(page.locator('#checkout-title')).toHaveText('订单已关闭或过期');await page.locator('#refresh-payment').click();
  expect((await billingApi(page,'POST','/__billing-test/api/payment/outcome',{id:closed.order.order_id,outcome:'paid',delivery:'callback'},billing.owner)).status).toBe(409);
  const forged=await billingApi(page,'POST','/api/v1/payments/wechat/callback',{orderId:order.order_id,state:'paid'});expect(forged.status).toBe(401);expect(forged.body.code).toBe('PAYMENT_INVALID');
  expect(fundsOnly(billing.checkpoint('failed-closed-forged-no-funds-change'))).toEqual(fundsOnly(credited));accountAmounts(await channelState(page,billing.owner),200n);
});

test('billing04 real refund UI pending failure releases its exact frozen points once',async({page,billing})=>{
  const {order}=await topupApi(page,'1000');await payViaQuery(page,billing.owner,order.order_id);await openCashier(page,order.order_id);await page.locator('#refund-amount').fill('2.00');
  const request=page.waitForResponse(r=>new URL(r.url()).pathname==='/__billing-test/api/refund/request');await page.getByRole('button',{name:'提交模拟原路退款申请',exact:true}).click();const response=await request;expect(response.status()).toBe(200);const original=response.request().postDataJSON();
  const state=await channelState(page,billing.owner),refund=state.refunds[0];expect(refund.order_id).toBe(order.order_id);expect(['requested','processing']).toContain(refund.state);accountAmounts(state,800n,200n);
  await expect(page.locator(`[data-refund="${refund.id}"] h3`)).not.toContainText('成功');billing.checkpoint('refund-requested-freezes-but-is-not-refunded');
  await page.locator(`[data-refund-id="${refund.id}"][data-refund-action="failed"]`).click();accountAmounts(await channelState(page,billing.owner),800n,200n);
  await page.locator(`[data-refund-id="${refund.id}"][data-refund-action="refresh"]`).click();await expect(page.locator(`[data-refund="${refund.id}"] h3`)).toContainText('模拟原路退款失败');accountAmounts(await channelState(page,billing.owner),1000n);
  const released=billing.checkpoint('failed-refund-releases-original-lot');expect(released.events.filter((e:any)=>e.kind==='refund_release')).toHaveLength(1);expect(released.events.find((e:any)=>e.kind==='refund_release').points).toBe('200');
  for(let i=0;i<3;i++){expect((await billingApi(page,'POST','/__billing-test/api/refund/outcome',{id:refund.id,outcome:'failed',delivery:'callback'},billing.owner)).status).toBe(200);expect((await billingApi(page,'POST',`/api/v1/commerce/refunds/${refund.id}/refresh`,{})).status).toBe(200);}
  const replay=await billingApi(page,'POST',`/api/v1/commerce/topups/${order.order_id}/refunds`,{request_id:original.request_id,amount_fen:original.amount_fen});expect(replay.status).toBe(202);expect(replay.body.refund_id).toBe(refund.id);
  expect(billing.checkpoint('failed-refund-terminal-replays-no-second-release')).toEqual(released);
});

test('billing05 refund overage altered requests foreign owners and terminal replays cannot spend twice',async({page,billing,browser})=>{
  const {order}=await topupApi(page,'1000');await payViaQuery(page,billing.owner,order.order_id);const baseline=billing.checkpoint('paid-order-refund-baseline');
  for(const amount_fen of ['0',0])expect((await billingApi(page,'POST',`/api/v1/commerce/topups/${order.order_id}/refunds`,{request_id:randomUUID(),amount_fen})).status).toBe(422);
  expect((await billingApi(page,'POST',`/api/v1/commerce/topups/${order.order_id}/refunds`,{request_id:randomUUID(),amount_fen:'1001'})).status).toBe(409);expect(billing.checkpoint('rejected-refunds-no-freeze')).toEqual(baseline);
  const body={request_id:randomUUID(),amount_fen:'300'},path=`/api/v1/commerce/topups/${order.order_id}/refunds`;
  const created=await Promise.all(Array.from({length:6},()=>billingApi(page,'POST',path,body)));created.forEach(r=>expect(r.status).toBe(202));const ids=new Set(created.map(r=>r.body.refund_id));expect(ids.size).toBe(1);const id=[...ids][0] as string;accountAmounts(await channelState(page,billing.owner),700n,300n);
  expect((await billingApi(page,'POST',path,{...body,amount_fen:'301'})).status).toBe(409);
  expect((await billingApi(page,'POST','/__billing-test/api/refund/outcome',{id,outcome:'succeeded',delivery:'query'},billing.owner)).status).toBe(200);accountAmounts(await channelState(page,billing.owner),700n,300n);billing.checkpoint('channel-refund-success-still-awaits-product-query');
  const refresh=await Promise.all(Array.from({length:6},()=>billingApi(page,'POST',`/api/v1/commerce/refunds/${id}/refresh`,{})));refresh.forEach(r=>expect(r.status).toBe(200));accountAmounts(await channelState(page,billing.owner),700n);
  const settled=billing.checkpoint('refund-succeeded-once');expect(settled.events.filter((e:any)=>e.kind==='refund_settle')).toHaveLength(1);expect(settled.events.find((e:any)=>e.kind==='refund_settle').points).toBe('300');expect(settled.refundEvents.filter((e:any)=>e.kind==='succeeded')).toHaveLength(1);
  for(let i=0;i<3;i++)expect((await billingApi(page,'POST','/__billing-test/api/refund/outcome',{id,outcome:'succeeded',delivery:'callback'},billing.owner)).status).toBe(200);
  const replay=await billingApi(page,'POST',path,body);expect(replay.status).toBe(202);expect(replay.body.refund_id).toBe(id);expect((await billingApi(page,'POST',path,{request_id:randomUUID(),amount_fen:'701'})).status).toBe(409);expect(billing.checkpoint('successful-refund-all-replays-preserve-ledger')).toEqual(settled);
  const foreignContext=await browser.newContext({baseURL:'http://localhost:18087',viewport:{width:1440,height:1000}}),foreign=await foreignContext.newPage();
  try{const other=await registerBillingAccount(foreign),otherBefore=billingLedger(other.owner);
    for(const [method,foreignPath,payload] of [
      ['POST',`/api/v1/commerce/topups/${order.order_id}/refresh`,{}],['POST',path,{request_id:randomUUID(),amount_fen:'1'}],
      ['POST',`/api/v1/commerce/refunds/${id}/refresh`,{}],['POST','/__billing-test/api/refund/outcome',{id,outcome:'succeeded',delivery:'callback'}]
    ] as const){const r=await billingApi(foreign,method,foreignPath,payload,other.owner);expect([403,404]).toContain(r.status);billing.record('foreign-resource-denied',{method,path:foreignPath,...r});}
    const wrongOwner=await billingApi(foreign,'POST','/__billing-test/api/payment/outcome',{id:order.order_id,outcome:'paid',delivery:'callback'},billing.owner);expect(wrongOwner.status).toBe(403);
    expect(billingLedger(other.owner)).toEqual(otherBefore);expect(billingLedger(billing.owner)).toEqual(settled);await openCashier(foreign,order.order_id);await expect(foreign.locator('#checkout-title')).toHaveText('订单不可用');await expect(foreign.locator('body')).not.toContainText(billing.username);await foreign.screenshot({path:billing.directory+'/foreign-order-denied.png',fullPage:true});
  }finally{await foreignContext.close();}
});

test('billing08 legacy numeric wire replays locked payment while new requests require current protocol',async({page,billing})=>{
  const before=billing.checkpoint('before-legacy-wire-request'),requestId=randomUUID(),legacy={request_id:requestId,amount_fen:150,provider:'wechat'};
  const denied=await billingApi(page,'POST','/api/v1/commerce/topups',legacy,undefined,LEGACY_BILLING_WIRE_VERSION);expect(denied.status).toBe(409);expect(denied.body.code).toBe('BILLING_PROTOCOL_REPLAY_ONLY');billing.record('old-client-new-purchase-explicitly-refused',denied);expect(billing.checkpoint('legacy-new-purchase-no-ledger')).toEqual(before);
  const current={...legacy,amount_fen:'150'},created=await billingApi(page,'POST','/api/v1/commerce/topups',current);expect(created.status).toBe(201);const order=created.body.order_id;
  const oldReplay=await billingApi(page,'POST','/api/v1/commerce/topups',legacy,undefined,LEGACY_BILLING_WIRE_VERSION);expect(oldReplay.status).toBe(201);expect(oldReplay.body.order_id).toBe(order);expect(oldReplay.body.amount_fen).toBe(150);
  expect((await billingApi(page,'POST','/__billing-test/api/payment/outcome',{id:order,outcome:'paid',delivery:'query'},billing.owner)).status).toBe(200);accountAmounts(await channelState(page,billing.owner),0n);
  const paid=await billingApi(page,'POST',`/api/v1/commerce/topups/${order}/refresh`,{},undefined,LEGACY_BILLING_WIRE_VERSION);expect(paid.status).toBe(200);expect(paid.body.amount_fen).toBe(150);accountAmounts(await channelState(page,billing.owner),150n);const credited=billing.checkpoint('legacy-query-original-payment-credited');
  for(let i=0;i<3;i++){const replay=await billingApi(page,'POST','/api/v1/commerce/topups',legacy,undefined,LEGACY_BILLING_WIRE_VERSION);expect(replay.status).toBe(201);expect(replay.body.order_id).toBe(order);expect((await billingApi(page,'POST',`/api/v1/commerce/topups/${order}/refresh`,{})).status).toBe(200);}
  const altered=await billingApi(page,'POST','/api/v1/commerce/topups',{...legacy,amount_fen:151},undefined,LEGACY_BILLING_WIRE_VERSION);expect(altered.status).toBe(409);expect(altered.body.code).toBe('IDEMPOTENCY_CONFLICT');expect(billing.checkpoint('old-current-replays-preserve-price-and-single-credit')).toEqual(credited);
  const another={request_id:randomUUID(),amount_fen:20,provider:'wechat'},blocked=await billingApi(page,'POST','/api/v1/commerce/topups',another,undefined,LEGACY_BILLING_WIRE_VERSION);expect(blocked.status).toBe(409);expect(blocked.body.code).toBe('BILLING_PROTOCOL_REPLAY_ONLY');
  await page.goto('/#/account');await page.reload();const repaired=await billingApi(page,'POST','/api/v1/commerce/topups',{...another,amount_fen:'20'});expect(repaired.status).toBe(201);expect((await billingApi(page,'POST','/__billing-test/api/payment/close',{id:repaired.body.order_id},billing.owner)).status).toBe(200);expect(fundsOnly(billing.checkpoint('refresh-current-protocol-can-create-with-no-extra-credit'))).toEqual(fundsOnly(credited));
});

for(const [caseId,cycle,delivery] of [['10','monthly','query'],['11','annual','callback']] as const){
  test(`billing${caseId} real ${cycle} subscription purchase issues only due rights and repeated payment cannot issue twice`,async({page,billing})=>{
    const catalog=await billingApi(page,'GET','/api/v1/subscriptions/catalog');
    expect(catalog.status).toBe(200);expect(catalog.body.enabled).toBe(true);
    const plan=catalog.body.plans.find((p:any)=>p.id==='light');expect(plan).toBeTruthy();
    const monthlyPoints=integer(plan.points),amountFen=integer(cycle==='annual'?plan.annual_amount_fen:plan.amount_fen);
    const totalPoints=monthlyPoints*(cycle==='annual'?12n:1n);
    billing.record('displayed-subscription-rights',{catalog:catalog.body,plan,cycle,amountFen:amountFen.toString(),monthlyPoints:monthlyPoints.toString(),totalPoints:totalPoints.toString()});
    await page.goto('/#/account');await page.locator(`[data-billing-cycle="${cycle}"]`).click();
    const responsePending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/subscriptions'&&r.request().method()==='POST');
    await page.locator('[data-subscribe="light"]').click();const response=await responsePending;
    expect(response.status(),await response.text()).toBe(201);
    const checkout=await response.json(),original=response.request().postDataJSON(),order=checkout.order;
    expect(order.amount_fen).toBe(amountFen.toString());expect(order.points).toBe(totalPoints.toString());
    expect(checkout.subscription.status).toBe('pending');expect(checkout.subscription.auto_renew).toBe(false);
    expect(checkout.subscription.billing_cycle).toBe(cycle);
    const pending=billing.checkpoint('subscription-pending-has-no-spendable-rights');
    expect(pending.lots).toHaveLength(0);expect(pending.events).toHaveLength(0);expect(pending.subscriptionPeriods).toHaveLength(1);
    expect(pending.subscriptionPeriods[0].status).toBe('pending');expect(pending.subscriptionReleases).toHaveLength(0);
    accountAmounts(await channelState(page,billing.owner),0n);
    const repeatedPending=await Promise.all(Array.from({length:4},()=>billingApi(page,'POST','/api/v1/subscriptions',original)));
    repeatedPending.forEach(r=>{expect(r.status).toBe(201);expect(r.body.order.order_id).toBe(order.order_id);});
    expect((await billingApi(page,'POST','/api/v1/subscriptions',{...original,plan_id:'professional'})).status).toBe(409);
    expect(billing.checkpoint('pending-subscription-original-request-replays-one-order')).toEqual(pending);
    await page.getByRole('link',{name:'打开模拟收银台',exact:true}).click();
    await page.locator('#delivery').selectOption(delivery);await page.locator('#simulate-paid').click();
    if(delivery==='query'){
      await expect(page.locator('#checkout-title')).toHaveText('渠道已支付，产品待核实入账');
      accountAmounts(await channelState(page,billing.owner),0n);
      expect(billing.checkpoint('subscription-channel-paid-not-yet-credited')).toEqual(pending);
      await page.locator('#refresh-payment').click();
    }
    await expect(page.locator('#checkout-title')).toHaveText('积分已到账');
    accountAmounts(await channelState(page,billing.owner),monthlyPoints);
    const activated=billing.checkpoint('verified-subscription-issues-exact-first-month');
    expect(activated.orders).toHaveLength(1);expect(activated.orders[0].state).toBe('paid');
    expect(activated.lots).toHaveLength(1);expect(activated.events.filter((e:any)=>e.kind==='grant')).toHaveLength(1);
    const lot=activated.lots[0],period=activated.subscriptionPeriods[0],subscription=activated.subscriptions[0];
    expect(lot.source).toBe('subscription');expect(lot.source_key).toBe('recharge:'+order.order_id);
    expect(lot.original_points).toBe(monthlyPoints.toString());expect(lot.remaining).toBe(monthlyPoints.toString());
    expect(lot.cash_order_id).toBe(order.order_id);expect(lot.cash_basis_points).toBe(monthlyPoints.toString());
    expect(lot.cash_basis_fen).toBe((amountFen/(cycle==='annual'?12n:1n)).toString());
    expect(new Date(lot.expires_at).getTime()-new Date(period.starts_at).getTime()).toBe(90*86400000);
    expect(period.order_id).toBe(order.order_id);expect(period.status).toBe('active');expect(period.points).toBe(totalPoints.toString());
    expect(period.monthly_points).toBe(monthlyPoints.toString());expect(period.billing_cycle).toBe(cycle);expect(period.automatic).toBe(false);
    expect(subscription.status).toBe('active');expect(subscription.auto_renew).toBe(false);expect(subscription.auto_renew_requested).toBe(false);
    expect(subscription.mandate_status).toBe('none');expect(subscription.task_price_version).toBe(period.task_price_version);
    if(cycle==='annual'){
      expect(activated.subscriptionReleases).toHaveLength(12);
      expect(activated.subscriptionReleases.filter((r:any)=>r.state==='issued')).toHaveLength(1);
      expect(activated.subscriptionReleases.filter((r:any)=>r.state==='scheduled')).toHaveLength(11);
      expect(activated.subscriptionReleases.reduce((sum:bigint,r:any)=>sum+integer(r.points),0n)).toBe(totalPoints);
      expect(activated.subscriptionReleases.reduce((sum:bigint,r:any)=>sum+integer(r.amount_fen),0n)).toBe(amountFen);
    }else expect(activated.subscriptionReleases).toHaveLength(0);
    const account=await billingApi(page,'GET','/api/v1/subscriptions/account');expect(account.status).toBe(200);
    expect(account.body.available_points).toBe(monthlyPoints.toString());expect(account.body.subscription_available_points).toBe(monthlyPoints.toString());
    expect(account.body.topup_available_points).toBe('0');expect(account.body.periods).toHaveLength(1);
    expect(account.body.periods[0].released_count).toBe(1);expect(account.body.periods[0].release_count).toBe(cycle==='annual'?12:1);
    expect(account.body.subscription.next_charge_at).toBeNull();expect(account.body.subscription.next_charge_amount_fen).toBeNull();
    billing.record('real-subscription-account-agrees-with-wallet',account);
    await Promise.all(Array.from({length:4},async()=>{
      expect((await billingApi(page,'POST',`/api/v1/commerce/topups/${order.order_id}/refresh`,{})).status).toBe(200);
      expect((await billingApi(page,'POST','/__billing-test/api/payment/outcome',{id:order.order_id,outcome:'paid',delivery:'callback'},billing.owner)).status).toBe(200);
      const replay=await billingApi(page,'POST','/api/v1/subscriptions',original);expect(replay.status).toBe(201);expect(replay.body.order.order_id).toBe(order.order_id);
    }));
    expect((await billingApi(page,'POST',`/api/v1/subscriptions/${subscription.id}/renew`,{...original,request_id:randomUUID()})).status).toBe(409);
    expect(billing.checkpoint('repeated-subscription-payment-and-premature-renewal-preserve-all-rights')).toEqual(activated);
    const accountAfter=await billingApi(page,'GET','/api/v1/subscriptions/account');expect(accountAfter.body).toEqual(account.body);
    await page.locator('#return-paid').click();await expect(page.locator(`[data-period="${period.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-period="${period.id}"]`)).toContainText(cycle==='annual'?'已发放 1/12 个月':'轻量');
    await page.reload();await expect(page.locator(`[data-period="${period.id}"]`)).toBeVisible();
    expect(billing.checkpoint('subscription-browser-refresh-keeps-one-payment-and-monthly-balance')).toEqual(activated);
  });
}
