import {expect,test,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {schemas} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {installSupplementHttp,mountSupplementSurface,supplementFixture,supplementHash,supplementIds,supplementNow,type SupplementFixture,type SupplementSurface} from './run-supplement-fixture';

const panel=(page:Page)=>page.locator(`[data-run-supplement="${supplementIds.run}"]`);
const action=(page:Page,name:string)=>panel(page).locator(`[data-supplement-action="${name}"]`);
const journalKey=`bondbuddy:run-supplement-adoption:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`;
const json=(r:Route,body:unknown,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function install(page:Page,s:SupplementFixture){
  await installSupplementHttp(page,s);
  const f={points:4500,quoteRequests:[] as Dto<'RunSupplementQuoteRequest'>[],confirms:[] as Dto<'RunSupplementQuoteConfirmRequest'>[],
    adopts:[] as Dto<'RunSupplementAdoptRequest'>[],reads:[] as string[],quotes:new Map<string,Dto<'RunSupplementQuoteResponse'>>(),
    receipts:new Map<string,Dto<'RunSupplementAdoptionResponse'>>(),dropQuote:false,dropConfirm:false,dropAdopt:false,failReads:false,lowBalance:false,stale:false};
  await page.context().route(/\/api\/v1\/runs\/[^/]+\/supplement-(quotes|adoptions)(?:[/?]|$)/,async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,body=request.postDataJSON();
    if(path.endsWith('/supplement-adoptions')){
      if(request.method()==='GET'){const id=url.searchParams.get('request_id')!;f.reads.push(id);if(f.failReads)return json(route,{code:'DATA_UNAVAILABLE'},503);return f.receipts.has(id)?json(route,f.receipts.get(id)):json(route,{code:'NOT_FOUND'},404);}
      expect(Value.Check(schemas.RunSupplementAdoptRequest,body)).toBe(true);f.adopts.push(structuredClone(body));
      if(f.receipts.has(body.request_id))return json(route,f.receipts.get(body.request_id));
      if(f.stale)return json(route,{code:'QUOTE_CHANGED'},409);if(f.lowBalance)return json(route,{code:'CREDITS_INSUFFICIENT'},402);
      const q=[...f.quotes.values()].find(q=>q.quote.quote_id===body.quote_id)!;
      const receipt:Dto<'RunSupplementAdoptionResponse'>={adoption:{adoption_id:'adoption-'+body.request_id,request_id:body.request_id,
        project_id:s.project.project_id,run_id:s.run.run_id,job_id:'supplement-job',execution_version:2,input_revision:8,input_hash:supplementHash('adopted-input'),
        quote_id:body.quote_id,confirmation_id:body.confirmation_id,quote_hash:body.quote_hash,adopted_at:supplementNow,
        ...(q.quote.total_points?{assignment_kind:'rework' as const,additional_points:q.quote.total_points,billing_segment_id:'new-fee',reservation_id:'new-fee'}:
          {assignment_kind:'carry' as const,additional_points:0 as const,billing_segment_id:'supplement-reservation',reservation_id:'supplement-reservation'})}};
      f.receipts.set(body.request_id,receipt);s.run.state='queued';
      if(f.dropAdopt){f.dropAdopt=false;return route.abort('connectionreset');}return json(route,receipt);
    }
    if(path.endsWith('/supplement-quotes')&&request.method()==='POST'){
      expect(Value.Check(schemas.RunSupplementQuoteRequest,body)).toBe(true);f.quoteRequests.push(structuredClone(body));
      if(f.stale)return json(route,{code:'QUOTE_CHANGED'},409);
      if(!f.quotes.has(body.request_id))f.quotes.set(body.request_id,{quote:{quote_id:'quote-'+body.request_id,project_id:s.project.project_id,run_id:s.run.run_id,
        supplement_revision:body.supplement_revision,saved_request_id:body.saved_request_id,pricing_rule:'b1_full_document_v1',
        items:[f.points?{target_id:'original-document',document_name:'本轮募集说明书',needs_redo:true,task_type:'annual',price_version:'synthetic-price-v1',full_price_points:f.points,points:f.points}:
          {target_id:'original-document',document_name:'本轮募集说明书',needs_redo:false,task_type:null,price_version:null,full_price_points:null,points:0}],
        total_points:f.points,quote_hash:supplementHash(body.request_id),created_at:supplementNow,expires_at:'2099-01-01T00:00:00Z'},confirmation:null});
      if(f.dropQuote){f.dropQuote=false;return route.abort('connectionreset');}return json(route,f.quotes.get(body.request_id));
    }
    if(path.includes('/supplement-quotes/')){
      const quoteId=path.split('/')[6],q=[...f.quotes.values()].find(q=>q.quote.quote_id===quoteId);
      if(!q)return json(route,{code:'NOT_FOUND'},404);
      if(request.method()==='GET')return json(route,q);
      expect(Value.Check(schemas.RunSupplementQuoteConfirmRequest,body)).toBe(true);f.confirms.push(structuredClone(body));
      if(f.stale)return json(route,{code:'QUOTE_CHANGED'},409);
      q.confirmation??={confirmation_id:'confirmation-'+body.request_id,quote_id:q.quote.quote_id,project_id:s.project.project_id,run_id:s.run.run_id,
        request_id:body.request_id,quote_hash:body.quote_hash,total_points:q.quote.total_points,confirmed_at:supplementNow};
      if(f.dropConfirm){f.dropConfirm=false;return route.abort('connectionreset');}return json(route,q);
    }
    return route.fallback();
  });return f;
}
async function saved(page:Page,s:SupplementFixture,surface:SupplementSurface='panel'){
  await mountSupplementSurface(page,s,surface);await expect(action(page,'save')).toBeVisible();
  await panel(page).locator('[data-supplement-role]').selectOption('audit');
  await panel(page).locator('[data-supplement-file]').setInputFiles({name:'补充证据.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic rework evidence')});
  await expect(action(page,'save')).toBeEnabled();await action(page,'save').click();await expect(action(page,'quote')).toBeEnabled();
}

for(const surface of ['m1','m3','m4'] as const)test(`desktop ${surface}: B1 exact quote requires explicit consent, and refresh cannot authorize a charge`,async({page})=>{
  const s=supplementFixture(),f=await install(page,s);await saved(page,s,surface);
  await action(page,'quote').click();await expect(action(page,'adopt')).toHaveText('确认追加 4500 积分并继续');
  await expect(panel(page)).toContainText('本轮募集说明书');await expect(panel(page)).toContainText('按当前完整文档价格');
  if(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR){await mkdir(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR,{recursive:true});await panel(page).scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR,`${surface}-b1-quote.png`),fullPage:true});}
  expect(f.confirms).toEqual([]);expect(f.adopts).toEqual([]);expect(s.controls).toEqual([]);
  await page.reload();await mountSupplementSurface(page,s,surface);await expect(action(page,'adopt')).toBeEnabled();
  expect(f.confirms).toEqual([]);expect(f.adopts).toEqual([]);expect(f.quoteRequests).toHaveLength(1);
  await action(page,'adopt').click();await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('补料已采用');
  if(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR)await page.screenshot({path:join(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR,`${surface}-b1-adopted.png`),fullPage:true});
  expect(f.confirms).toHaveLength(1);expect(f.adopts).toHaveLength(1);expect(s.saves).toHaveLength(1);expect(s.byteWrites).toBe(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
});

test('zero additional quote explains continued original fees and still needs an explicit continue',async({page})=>{
  const s=supplementFixture(),f=await install(page,s);f.points=0;await saved(page,s);await action(page,'quote').click();
  await expect(panel(page)).toContainText('原任务尚未结算的费用仍按原规则继续累计');await expect(action(page,'adopt')).toHaveText('确认追加 0 积分并继续');
  expect(f.adopts).toEqual([]);await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');expect(f.adopts).toHaveLength(1);
});

test('accepted adoption with a lost response survives refresh and recovers GET by original request_id',async({page})=>{
  const s=supplementFixture(),f=await install(page,s);f.dropAdopt=true;f.failReads=true;await saved(page,s);await action(page,'quote').click();await action(page,'adopt').click();
  await expect(panel(page)).toContainText('原采用结果尚未确认');expect(f.adopts).toHaveLength(1);const sent=structuredClone(f.adopts[0]);
  f.failReads=false;f.stale=true;await page.reload();await mountSupplementSurface(page,s);
  await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('补料已采用');expect(f.adopts).toEqual([sent]);expect(f.reads.filter(id=>id===sent.request_id).length).toBeGreaterThan(1);
  expect(f.confirms).toHaveLength(1);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
});

test('low balance retries the exact adoption request after recharge',async({page})=>{
  const s=supplementFixture(),f=await install(page,s);f.lowBalance=true;await saved(page,s);await action(page,'quote').click();await action(page,'adopt').click();
  await expect(panel(page)).toContainText('积分不足，补料尚未采用');const sent=structuredClone(f.adopts[0]);expect(s.run.state).toBe('paused');
  f.lowBalance=false;await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');
  expect(f.adopts).toEqual([sent,sent]);expect(f.confirms).toHaveLength(1);expect(s.saves).toHaveLength(1);
});

test('lost quote and confirmation responses restore read-only and preserve their request IDs',async({page})=>{
  const s=supplementFixture(),f=await install(page,s);f.dropQuote=true;await saved(page,s);await action(page,'quote').click();await expect.poll(()=>f.quoteRequests.length).toBe(1);
  await expect(action(page,'quote')).toBeEnabled();const first=structuredClone(f.quoteRequests[0]);await page.reload();await mountSupplementSurface(page,s);
  await expect(action(page,'quote')).toBeEnabled();expect(f.quoteRequests).toEqual([first]);await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.quoteRequests).toEqual([first,first]);
  f.dropConfirm=true;await action(page,'adopt').click();await expect.poll(()=>f.confirms.length).toBe(1);await expect(action(page,'adopt')).toBeEnabled();expect(f.adopts).toEqual([]);
  const confirm=structuredClone(f.confirms[0]);await page.reload();await mountSupplementSurface(page,s);await expect(action(page,'adopt')).toBeEnabled();expect(f.adopts).toEqual([]);
  await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');expect(f.confirms).toEqual([confirm]);expect(f.adopts).toHaveLength(1);
});

test('changed or expired quotes require a new fee check while retaining saved drafts/uploads',async({page})=>{
  const s=supplementFixture(),f=await install(page,s);await saved(page,s);await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();
  f.stale=true;await action(page,'adopt').click();await expect(panel(page)).toContainText('材料、暂停进度或报价已变化');expect(f.adopts).toEqual([]);expect(s.saves).toHaveLength(1);
  f.stale=false;await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.quoteRequests[1].request_id).not.toBe(f.quoteRequests[0].request_id);
  const latest=[...f.quotes.values()].at(-1)!;latest.quote.expires_at='2020-01-01T00:00:00Z';
  await page.reload();await mountSupplementSurface(page,s);await expect(panel(page)).toContainText('报价已过期');await expect(action(page,'adopt')).toBeDisabled();
  const confirmations=f.confirms.length;await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.confirms).toHaveLength(confirmations);expect(f.adopts).toEqual([]);expect(s.uploads).toHaveLength(1);
});

test('a second tab changes consent journal; stale tab must explicitly reload before any charge',async({page,context})=>{
  const s=supplementFixture(),f=await install(page,s);await saved(page,s);await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();
  const other=await context.newPage();await mountSupplementSurface(other,s);await expect(action(other,'adopt')).toBeEnabled();
  await other.evaluate(key=>{const j=JSON.parse(localStorage.getItem(key)!);j.confirm={request_id:'other-page-confirmation',quote_hash:j.quote.quote.quote_hash};localStorage.setItem(key,JSON.stringify(j));},journalKey);
  await expect(panel(page)).toContainText('另一页面的追加费用记录已有变化');await expect(action(page,'adopt')).toBeDisabled();expect(f.adopts).toEqual([]);
  await action(page,'adoption-local-reload').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.adopts).toEqual([]);
  await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');expect(f.confirms[0].request_id).toBe('other-page-confirmation');expect(f.adopts).toHaveLength(1);
});
