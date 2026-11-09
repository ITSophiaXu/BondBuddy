import {test as base, expect, type Page} from '@playwright/test';
import {BILLING_WIRE_HEADER, BILLING_WIRE_VERSION, LEGACY_BILLING_WIRE_VERSION, billingWireRoute, validateBillingDto, encodeBillingDto} from '@bondbuddy/contracts';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evidenceLifecycle,finalizeEvidence} from './local-prelaunch-evidence';

const repo=fileURLToPath(new URL('../../..',import.meta.url));
export const billingOrigin='http://localhost:18087';
export function billingConfig(){
  const c=JSON.parse(readFileSync(join(repo,'.local/local-prelaunch/config.json'),'utf8'));
  if(process.env.BB_E2E_LOCAL_PRELAUNCH!=='1'||process.env.BB_E2E_BASE_URL!==billingOrigin||c.origin!==billingOrigin||
    !/^bb_billing_functional_[a-f0-9]{16}$/.test(c.database)||!/^bb-prelaunch-[a-f0-9]{12}$/.test(c.projectName)||!c.instanceId||!c.terms)
    throw Error('Explicit dedicated local prelaunch environment required.');
  return c;
}
export interface Reply {status:number; body:any; billingFormat:string|null;}
export async function billingApi(page:Page,method:string,path:string,body?:unknown,expectedOwner?:string,wireVersion:string=BILLING_WIRE_VERSION):Promise<Reply>{
  if(!path.startsWith('/api/v1/')&&!path.startsWith('/__legacy/api/v1/')&&!path.startsWith('/__billing-test/api/'))throw Error('Local product/channel endpoints only.');
  const result=await page.evaluate(async({method,path,body,expectedOwner,format,version})=>{
    const csrf=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('bb_csrf='))?.slice(8)??'';
    const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{[format]:version,
      ...(method==='GET'?{}:{'x-bb-csrf':decodeURIComponent(csrf),'content-type':'application/json'}),
      ...(expectedOwner?{'x-bb-test-owner':expectedOwner}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();let value:any=text;try{value=text?JSON.parse(text):null;}catch{}
    return {status:response.status,body:value,billingFormat:response.headers.get(format)};
  },{method,path,body,expectedOwner,format:BILLING_WIRE_HEADER,version:wireVersion});
  const wire=billingWireRoute(method,path.replace(/^\/__legacy(?=\/api\/v1\/)/,''));
  if(result.status>=200&&result.status<300&&wire?.response){
    expect(result.billingFormat).toBe(wireVersion);validateBillingDto(wire.response,wireVersion===LEGACY_BILLING_WIRE_VERSION?encodeBillingDto(wire.response,result.body):result.body);
  }
  return result;
}
export const integer=(value:unknown)=>{
  if(typeof value==='string'&&/^\d+$/.test(value))return BigInt(value);
  // The private channel-control state returns domain values. Public billing DTOs are validated above.
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value);
  throw Error('Invalid exact billing amount');
};
export async function channelState(page:Page,owner:string){const r=await billingApi(page,'POST','/__billing-test/api/state',{},owner);expect(r.status).toBe(200);return r.body;}
export function accountAmounts(state:any,available:bigint,refundHeld=0n,taskHeld=0n){
  expect(integer(state.account.available_points)).toBe(available);expect(integer(state.account.refund_held_points)).toBe(refundHeld);expect(integer(state.account.task_held_points)).toBe(taskHeld);
}
const sqlLiteral=(value:string)=>`'${value.replaceAll("'","''")}'`;
export function billingLedger(owner:string):any{
  const c=billingConfig(),who=sqlLiteral(owner);
  const sql=`SELECT json_build_object(
    'lots',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,source,source_key,original_points::text,remaining::text,frozen::text,expires_at,cash_order_id,cash_basis_fen::text,cash_basis_points::text FROM bb_credit_lots WHERE owner_user_id=${who}) x),'[]'::json),
    'events',COALESCE((SELECT json_agg(x ORDER BY x.event_key) FROM (SELECT event_key,kind,points::text,lot_id,reservation_id,run_id,reason FROM bb_credit_events WHERE owner_user_id=${who}) x),'[]'::json),
    'orders',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,request_id,state,amount_fen::text,points::text,provider_txn_id FROM bb_recharge_orders WHERE owner_user_id=${who}) x),'[]'::json),
    'refunds',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,order_id,request_id,state,amount_fen::text,credit_points::text FROM bb_payment_refunds WHERE owner_user_id=${who}) x),'[]'::json),
    'refundEvents',COALESCE((SELECT json_agg(x ORDER BY x.event_key) FROM (SELECT event_key,refund_id,kind,amount_fen::text,cash_refunded_fen::text FROM bb_payment_refund_events WHERE owner_user_id=${who}) x),'[]'::json),
    'subscriptions',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,plan_id,status,billing_cycle,billing_amount_fen::text,auto_renew,auto_renew_requested,mandate_status,current_period_start,current_period_end,task_price_version FROM bb_subscriptions WHERE owner_user_id=${who}) x),'[]'::json),
    'subscriptionPeriods',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,subscription_id,cycle_index,order_id,plan_id,catalog_version,amount_fen::text,points::text,monthly_points::text,task_price_version,status,automatic,billing_cycle,lot_id,starts_at,ends_at,credits_expires_at FROM bb_subscription_periods WHERE owner_user_id=${who}) x),'[]'::json),
    'subscriptionReleases',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,period_id,installment_index,due_at,points::text,amount_fen::text,state,lot_id,issued_at,expires_at FROM bb_subscription_credit_releases WHERE owner_user_id=${who}) x),'[]'::json),
    'reservations',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,run_id,state,points::text,charged_points::text,billing_policy FROM bb_credit_reservations WHERE owner_user_id=${who}) x),'[]'::json),
    'allocations',COALESCE((SELECT json_agg(x ORDER BY x.reservation_id,x.lot_id) FROM (SELECT a.reservation_id,a.lot_id,a.points::text,a.charged_points::text FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id WHERE r.owner_user_id=${who}) x),'[]'::json),
    'runs',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT id,project_id,execution_request_id,state,stage,reservation_id,artifact_id FROM bb_runs WHERE owner_user_id=${who}) x),'[]'::json),
    'modelCalls',COALESCE((SELECT json_agg(x ORDER BY x.id) FROM (SELECT a.id,j.run_id,a.status,a.model_id,a.usage_status FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id WHERE a.owner_user_id=${who}) x),'[]'::json));`;
  const dockerArgs=['exec','-i',`${c.projectName}-postgres-1`,'psql','-U','bondbuddy','-d',c.database,'-X','-A','-t','-v','ON_ERROR_STOP=1'];
  const linuxRepo=repo.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d:string)=>'/mnt/'+d.toLowerCase());
  const result=process.platform==='win32'?execFileSync('wsl.exe',['-d',process.env.BB_PRELAUNCH_WSL_DISTRO??'BondBuddyM3','--cd',linuxRepo,'--','docker',...dockerArgs],{input:sql,encoding:'utf8',windowsHide:true,timeout:30000})
    :execFileSync('docker',dockerArgs,{input:sql,encoding:'utf8',timeout:30000});
  return JSON.parse(result.trim());
}
export function fundsOnly(ledger:any){return {lots:ledger.lots,events:ledger.events,refunds:ledger.refunds,refundEvents:ledger.refundEvents,subscriptions:ledger.subscriptions,subscriptionPeriods:ledger.subscriptionPeriods,subscriptionReleases:ledger.subscriptionReleases,reservations:ledger.reservations,allocations:ledger.allocations,runs:ledger.runs,modelCalls:ledger.modelCalls};}
export async function registerBillingAccount(page:Page){
  const c=billingConfig(),username='billing_'+randomUUID().replaceAll('-','').slice(0,16),password='Synthetic-'+randomUUID()+'!';
  await page.goto('/');await page.getByRole('link',{name:'注册',exact:true}).click();await expect(page.locator('#terms-version')).toHaveText(c.terms);
  await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);await page.locator('#reg-agree').check();
  const registered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/auth/register'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'注册并进入工作区',exact:true}).click();expect((await registered).status()).toBe(201);
  const me=await billingApi(page,'GET','/api/v1/me');expect(me.status).toBe(200);return {username,owner:me.body.user_id as string};
}
export async function topupApi(page:Page,amountFen:string,requestId=randomUUID()){
  const body={request_id:requestId,amount_fen:amountFen,provider:'wechat'};
  const r=await billingApi(page,'POST','/api/v1/commerce/topups',body);expect(r.status,JSON.stringify(r.body)).toBe(201);return {order:r.body,body};
}
export async function topupUI(page:Page,yuan:string){
  await page.goto('/#/account');await page.locator('#subscription-topup-amount').fill(yuan);
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/commerce/topups'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'充值并前往支付',exact:true}).click();const response=await pending;expect(response.status(),await response.text()).toBe(201);
  const order=await response.json(),body=response.request().postDataJSON();await expect(page).toHaveURL(new RegExp('order='+order.order_id));
  await page.getByRole('link',{name:'打开模拟收银台',exact:true}).click();await expect(page.locator('#checkout-title')).toContainText('等待模拟支付');return {order,body};
}
export async function openCashier(page:Page,orderId:string){await page.goto('/__prelaunch/checkout?'+new URLSearchParams({order:orderId,return_to:'/#/account?order='+orderId}));await expect(page.locator('#checkout-title')).not.toHaveText('读取原订单');}
export async function payViaQuery(page:Page,owner:string,orderId:string){
  expect((await billingApi(page,'POST','/__billing-test/api/payment/outcome',{id:orderId,outcome:'paid',delivery:'query'},owner)).status).toBe(200);
  expect((await billingApi(page,'POST',`/api/v1/commerce/topups/${orderId}/refresh`,{})).status).toBe(200);
}
export interface BillingAudit {owner:string;username:string;directory:string;record(label:string,value?:unknown):void;checkpoint(label:string):any;}
const invocation=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
export const test=base.extend<{billing:BillingAudit}>({billing:async({page},use,info)=>{
  const directory=join(process.env.BB_PRELAUNCH_EVIDENCE_ROOT??join(repo,'.local/local-prelaunch/billing'),invocation,info.title.replace(/[^A-Za-z0-9_-]/g,'-').slice(0,90));mkdirSync(directory,{recursive:true});
  const lifecycle=evidenceLifecycle();
  const timeline:any[]=[],requests:any[]=[],pageErrors:string[]=[];let account:{owner:string;username:string}|undefined,environmentStatus:any,config:ReturnType<typeof billingConfig>,finalLedgerObserved=false;
  page.on('pageerror',e=>pageErrors.push(e.message));page.on('response',r=>{const path=new URL(r.url()).pathname;if((path.startsWith('/api/v1/')&&!path.startsWith('/api/v1/auth/'))||path.startsWith('/__billing-test/api/'))requests.push({method:r.request().method(),path,status:r.status()});});
  const render=(finalized=false)=>JSON.stringify({schema:'local-prelaunch-billing-v1',syntheticAccounts:true,syntheticPaymentChannel:true,httpMocked:false,taskResultsFabricated:false,
    instanceId:config?.instanceId,database:config?.database,origin:config?.origin,environmentStatus,test:info.title,...lifecycle.state(info,finalized),expectedStatus:info.expectedStatus,...account,timeline,requests,pageErrors,finalLedgerObserved,
    sourceHashes:Object.fromEntries(readdirSync(join(repo,'apps/web/tests')).filter(p=>p.startsWith('local-prelaunch-')&&p.endsWith('.ts')).map(p=>[p,createHash('sha256').update(readFileSync(join(repo,'apps/web/tests',p))).digest('hex')]))},null,2);
  const write=(text:string)=>writeFileSync(join(directory,'evidence.json'),text),save=()=>write(render());
  try{save();config=billingConfig();await page.setViewportSize({width:1440,height:1000});
    const status=await page.request.get('/__prelaunch/status');expect(status.status()).toBe(200);environmentStatus=await status.json();
    expect(environmentStatus.instance_id).toBe(config.instanceId);expect(environmentStatus.production_server).toBe(true);
    expect(environmentStatus.synthetic_payment).toBe(true);expect(environmentStatus.model_results_synthetic).toBe(false);save();
    account=await registerBillingAccount(page);save();
    lifecycle.enter('test');
    await use({...account,directory,record(label,value){timeline.push({at:new Date().toISOString(),label,value});save();},checkpoint(label){const ledger=billingLedger(account!.owner);timeline.push({at:new Date().toISOString(),label,ledger});save();return ledger;}});
    lifecycle.enter('teardown');
    expect(pageErrors).toEqual([]);
  }catch(error){lifecycle.fail(error);}
  finally{lifecycle.enter('teardown');
    if(account){try{timeline.push({label:'final-ledger',ledger:billingLedger(account.owner)});finalLedgerObserved=true;}catch(error){timeline.push({label:'final-ledger-error',error:String(error)});lifecycle.fail(error,'final-ledger');}}
    if(!finalLedgerObserved&&lifecycle.state(info,true).status==='passed')lifecycle.fail(new Error('A successful billing audit requires a final ledger observation'),'final-ledger');
    if(!page.isClosed()){try{await page.screenshot({path:join(directory,lifecycle.state(info,true).status==='passed'?'final.png':'red.png'),fullPage:true});}catch(error){lifecycle.fail(error,'final-screenshot');}}
    await finalizeEvidence({lifecycle,render,write,attach:text=>info.attach('real-billing-evidence',{body:Buffer.from(text),contentType:'application/json'})});}
}});
export {expect};
