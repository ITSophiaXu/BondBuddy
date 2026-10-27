# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-adoption.spec.ts >> desktop m3: B1 exact quote requires explicit consent, and refresh cannot authorize a charge
- Location: tests\run-supplement-adoption.spec.ts:64:48

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-adoption]')
Expected substring: "补料已采用"
Received string:    "需重做的文档按该文档当前完整价格追加计费；不受影响的文档不追加费用。先核对报价，明确确认后采用补料并继续。本次追加费用本轮募集说明书：需要重做，按当前完整文档价格 · 4500 积分合计追加 4500 积分 · 报价有效至 2099年1月1日 08:00确认追加 4500 积分并继续核对追加费用无法访问这个项目，它可能已移除或不属于当前账号。"
Timeout: 5000ms

Call log:
  - Expect "toContainText" locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-adoption]') with timeout 5000ms
  - waiting for locator('[data-run-supplement="supplement-run"]').locator('[data-supplement-adoption]')
    14 × locator resolved to <div data-supplement-adoption="">…</div>
       - unexpected value "需重做的文档按该文档当前完整价格追加计费；不受影响的文档不追加费用。先核对报价，明确确认后采用补料并继续。本次追加费用本轮募集说明书：需要重做，按当前完整文档价格 · 4500 积分合计追加 4500 积分 · 报价有效至 2099年1月1日 08:00确认追加 4500 积分并继续核对追加费用无法访问这个项目，它可能已移除或不属于当前账号。"

```

```yaml
- paragraph: 需重做的文档按该文档当前完整价格追加计费；不受影响的文档不追加费用。先核对报价，明确确认后采用补料并继续。
- heading "本次追加费用" [level=4]
- list:
  - listitem: 本轮募集说明书：需要重做，按当前完整文档价格 · 4500 积分
- paragraph:
  - text: 合计追加
  - strong: 4500 积分
  - text: · 报价有效至 2099年1月1日 08:00
- button "确认追加 4500 积分并继续"
- button "核对追加费用"
- alert: 无法访问这个项目，它可能已移除或不属于当前账号。
```

# Test source

```ts
  1   | import {expect,test,type Page,type Route} from '@playwright/test';
  2   | import {Value} from '@sinclair/typebox/value';
  3   | import {mkdir} from 'node:fs/promises';
  4   | import {join} from 'node:path';
  5   | import {schemas} from '@bondbuddy/contracts';
  6   | import type {Dto} from '../src/api';
  7   | import {installSupplementHttp,mountSupplementSurface,supplementFixture,supplementHash,supplementIds,supplementNow,type SupplementFixture,type SupplementSurface} from './run-supplement-fixture';
  8   | 
  9   | const panel=(page:Page)=>page.locator(`[data-run-supplement="${supplementIds.run}"]`);
  10  | const action=(page:Page,name:string)=>panel(page).locator(`[data-supplement-action="${name}"]`);
  11  | const journalKey=`bondbuddy:run-supplement-adoption:v1:${supplementIds.owner}:${supplementIds.project}:${supplementIds.run}`;
  12  | const json=(r:Route,body:unknown,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  13  | async function install(page:Page,s:SupplementFixture){
  14  |   await installSupplementHttp(page,s);
  15  |   const f={points:4500,quoteRequests:[] as Dto<'RunSupplementQuoteRequest'>[],confirms:[] as Dto<'RunSupplementQuoteConfirmRequest'>[],
  16  |     adopts:[] as Dto<'RunSupplementAdoptRequest'>[],reads:[] as string[],quotes:new Map<string,Dto<'RunSupplementQuoteResponse'>>(),
  17  |     receipts:new Map<string,Dto<'RunSupplementAdoptionResponse'>>(),dropQuote:false,dropConfirm:false,dropAdopt:false,failReads:false,lowBalance:false,stale:false};
  18  |   await page.context().route('**/api/v1/runs/*/supplement-*',async route=>{
  19  |     const request=route.request(),url=new URL(request.url()),path=url.pathname,body=request.postDataJSON();
  20  |     if(path.endsWith('/supplement-adoptions')){
  21  |       if(request.method()==='GET'){const id=url.searchParams.get('request_id')!;f.reads.push(id);if(f.failReads)return json(route,{code:'DATA_UNAVAILABLE'},503);return f.receipts.has(id)?json(route,f.receipts.get(id)):json(route,{code:'NOT_FOUND'},404);}
  22  |       expect(Value.Check(schemas.RunSupplementAdoptRequest,body)).toBe(true);f.adopts.push(structuredClone(body));
  23  |       if(f.receipts.has(body.request_id))return json(route,f.receipts.get(body.request_id));
  24  |       if(f.stale)return json(route,{code:'QUOTE_CHANGED'},409);if(f.lowBalance)return json(route,{code:'CREDITS_INSUFFICIENT'},402);
  25  |       const q=[...f.quotes.values()].find(q=>q.quote.quote_id===body.quote_id)!;
  26  |       const receipt:Dto<'RunSupplementAdoptionResponse'>={adoption:{adoption_id:'adoption-'+body.request_id,request_id:body.request_id,
  27  |         project_id:s.project.project_id,run_id:s.run.run_id,job_id:'supplement-job',execution_version:2,input_revision:8,input_hash:supplementHash('adopted-input'),
  28  |         quote_id:body.quote_id,confirmation_id:body.confirmation_id,quote_hash:body.quote_hash,adopted_at:supplementNow,
  29  |         ...(q.quote.total_points?{assignment_kind:'rework' as const,additional_points:q.quote.total_points,billing_segment_id:'new-fee',reservation_id:'new-fee'}:
  30  |           {assignment_kind:'carry' as const,additional_points:0 as const,billing_segment_id:'supplement-reservation',reservation_id:'supplement-reservation'})}};
  31  |       f.receipts.set(body.request_id,receipt);s.run.state='queued';
  32  |       if(f.dropAdopt){f.dropAdopt=false;return route.abort('connectionreset');}return json(route,receipt);
  33  |     }
  34  |     if(path.endsWith('/supplement-quotes')&&request.method()==='POST'){
  35  |       expect(Value.Check(schemas.RunSupplementQuoteRequest,body)).toBe(true);f.quoteRequests.push(structuredClone(body));
  36  |       if(f.stale)return json(route,{code:'QUOTE_CHANGED'},409);
  37  |       if(!f.quotes.has(body.request_id))f.quotes.set(body.request_id,{quote:{quote_id:'quote-'+body.request_id,project_id:s.project.project_id,run_id:s.run.run_id,
  38  |         supplement_revision:body.supplement_revision,saved_request_id:body.saved_request_id,pricing_rule:'b1_full_document_v1',
  39  |         items:[f.points?{target_id:'original-document',document_name:'本轮募集说明书',needs_redo:true,task_type:'annual',price_version:'synthetic-price-v1',full_price_points:f.points,points:f.points}:
  40  |           {target_id:'original-document',document_name:'本轮募集说明书',needs_redo:false,task_type:null,price_version:null,full_price_points:null,points:0}],
  41  |         total_points:f.points,quote_hash:supplementHash(body.request_id),created_at:supplementNow,expires_at:'2099-01-01T00:00:00Z'},confirmation:null});
  42  |       if(f.dropQuote){f.dropQuote=false;return route.abort('connectionreset');}return json(route,f.quotes.get(body.request_id));
  43  |     }
  44  |     if(path.includes('/supplement-quotes/')){
  45  |       const quoteId=path.split('/')[6],q=[...f.quotes.values()].find(q=>q.quote.quote_id===quoteId);
  46  |       if(!q)return json(route,{code:'NOT_FOUND'},404);
  47  |       if(request.method()==='GET')return json(route,q);
  48  |       expect(Value.Check(schemas.RunSupplementQuoteConfirmRequest,body)).toBe(true);f.confirms.push(structuredClone(body));
  49  |       if(f.stale)return json(route,{code:'QUOTE_CHANGED'},409);
  50  |       q.confirmation??={confirmation_id:'confirmation-'+body.request_id,quote_id:q.quote.quote_id,project_id:s.project.project_id,run_id:s.run.run_id,
  51  |         request_id:body.request_id,quote_hash:body.quote_hash,total_points:q.quote.total_points,confirmed_at:supplementNow};
  52  |       if(f.dropConfirm){f.dropConfirm=false;return route.abort('connectionreset');}return json(route,q);
  53  |     }
  54  |     return route.fallback();
  55  |   });return f;
  56  | }
  57  | async function saved(page:Page,s:SupplementFixture,surface:SupplementSurface='panel'){
  58  |   await mountSupplementSurface(page,s,surface);await expect(action(page,'save')).toBeVisible();
  59  |   await panel(page).locator('[data-supplement-role]').selectOption('audit');
  60  |   await panel(page).locator('[data-supplement-file]').setInputFiles({name:'补充证据.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic rework evidence')});
  61  |   await expect(action(page,'save')).toBeEnabled();await action(page,'save').click();await expect(action(page,'quote')).toBeEnabled();
  62  | }
  63  | 
  64  | for(const surface of ['m1','m3','m4'] as const)test(`desktop ${surface}: B1 exact quote requires explicit consent, and refresh cannot authorize a charge`,async({page})=>{
  65  |   const s=supplementFixture(),f=await install(page,s);await saved(page,s,surface);
  66  |   await action(page,'quote').click();await expect(action(page,'adopt')).toHaveText('确认追加 4500 积分并继续');
  67  |   await expect(panel(page)).toContainText('本轮募集说明书');await expect(panel(page)).toContainText('按当前完整文档价格');
  68  |   if(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR){await mkdir(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR,{recursive:true});await panel(page).scrollIntoViewIfNeeded();await page.screenshot({path:join(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR,`${surface}-b1-quote.png`),fullPage:true});}
  69  |   expect(f.confirms).toEqual([]);expect(f.adopts).toEqual([]);expect(s.controls).toEqual([]);
  70  |   await page.reload();await mountSupplementSurface(page,s,surface);await expect(action(page,'adopt')).toBeEnabled();
  71  |   expect(f.confirms).toEqual([]);expect(f.adopts).toEqual([]);expect(f.quoteRequests).toHaveLength(1);
> 72  |   await action(page,'adopt').click();await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('补料已采用');
      |                                                                                                      ^ Error: expect(locator).toContainText(expected) failed
  73  |   if(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR)await page.screenshot({path:join(process.env.BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR,`${surface}-b1-adopted.png`),fullPage:true});
  74  |   expect(f.confirms).toHaveLength(1);expect(f.adopts).toHaveLength(1);expect(s.saves).toHaveLength(1);expect(s.byteWrites).toBe(1);expect(s.controls).toEqual([]);expect(s.unexpectedMutations).toEqual([]);
  75  | });
  76  | 
  77  | test('zero additional quote explains continued original fees and still needs an explicit continue',async({page})=>{
  78  |   const s=supplementFixture(),f=await install(page,s);f.points=0;await saved(page,s);await action(page,'quote').click();
  79  |   await expect(panel(page)).toContainText('原任务尚未结算的费用仍按原规则继续累计');await expect(action(page,'adopt')).toHaveText('确认追加 0 积分并继续');
  80  |   expect(f.adopts).toEqual([]);await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');expect(f.adopts).toHaveLength(1);
  81  | });
  82  | 
  83  | test('accepted adoption with a lost response survives refresh and recovers GET by original request_id',async({page})=>{
  84  |   const s=supplementFixture(),f=await install(page,s);f.dropAdopt=true;f.failReads=true;await saved(page,s);await action(page,'quote').click();await action(page,'adopt').click();
  85  |   await expect(panel(page)).toContainText('原采用结果尚未确认');expect(f.adopts).toHaveLength(1);const sent=structuredClone(f.adopts[0]);
  86  |   f.failReads=false;f.stale=true;await page.reload();await mountSupplementSurface(page,s);
  87  |   await expect(panel(page).locator('[data-supplement-adoption]')).toContainText('补料已采用');expect(f.adopts).toEqual([sent]);expect(f.reads.filter(id=>id===sent.request_id).length).toBeGreaterThan(1);
  88  |   expect(f.confirms).toHaveLength(1);expect(s.uploads).toHaveLength(1);expect(s.byteWrites).toBe(1);
  89  | });
  90  | 
  91  | test('low balance retries the exact adoption request after recharge',async({page})=>{
  92  |   const s=supplementFixture(),f=await install(page,s);f.lowBalance=true;await saved(page,s);await action(page,'quote').click();await action(page,'adopt').click();
  93  |   await expect(panel(page)).toContainText('积分不足，补料尚未采用');const sent=structuredClone(f.adopts[0]);expect(s.run.state).toBe('paused');
  94  |   f.lowBalance=false;await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');
  95  |   expect(f.adopts).toEqual([sent,sent]);expect(f.confirms).toHaveLength(1);expect(s.saves).toHaveLength(1);
  96  | });
  97  | 
  98  | test('lost quote and confirmation responses restore read-only and preserve their request IDs',async({page})=>{
  99  |   const s=supplementFixture(),f=await install(page,s);f.dropQuote=true;await saved(page,s);await action(page,'quote').click();await expect.poll(()=>f.quoteRequests.length).toBe(1);
  100 |   await expect(action(page,'quote')).toBeEnabled();const first=structuredClone(f.quoteRequests[0]);await page.reload();await mountSupplementSurface(page,s);
  101 |   await expect(action(page,'quote')).toBeEnabled();expect(f.quoteRequests).toEqual([first]);await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.quoteRequests).toEqual([first,first]);
  102 |   f.dropConfirm=true;await action(page,'adopt').click();await expect.poll(()=>f.confirms.length).toBe(1);await expect(action(page,'adopt')).toBeEnabled();expect(f.adopts).toEqual([]);
  103 |   const confirm=structuredClone(f.confirms[0]);await page.reload();await mountSupplementSurface(page,s);await expect(action(page,'adopt')).toBeEnabled();expect(f.adopts).toEqual([]);
  104 |   await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');expect(f.confirms).toEqual([confirm]);expect(f.adopts).toHaveLength(1);
  105 | });
  106 | 
  107 | test('changed or expired quotes require a new fee check while retaining saved drafts/uploads',async({page})=>{
  108 |   const s=supplementFixture(),f=await install(page,s);await saved(page,s);await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();
  109 |   f.stale=true;await action(page,'adopt').click();await expect(panel(page)).toContainText('材料、暂停进度或报价已变化');expect(f.adopts).toEqual([]);expect(s.saves).toHaveLength(1);
  110 |   f.stale=false;await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.quoteRequests[1].request_id).not.toBe(f.quoteRequests[0].request_id);
  111 |   const latest=[...f.quotes.values()].at(-1)!;latest.quote.expires_at='2020-01-01T00:00:00Z';
  112 |   await page.reload();await mountSupplementSurface(page,s);await expect(panel(page)).toContainText('报价已过期');await expect(action(page,'adopt')).toBeDisabled();
  113 |   const confirmations=f.confirms.length;await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.confirms).toHaveLength(confirmations);expect(f.adopts).toEqual([]);expect(s.uploads).toHaveLength(1);
  114 | });
  115 | 
  116 | test('a second tab changes consent journal; stale tab must explicitly reload before any charge',async({page,context})=>{
  117 |   const s=supplementFixture(),f=await install(page,s);await saved(page,s);await action(page,'quote').click();await expect(action(page,'adopt')).toBeEnabled();
  118 |   const other=await context.newPage();await mountSupplementSurface(other,s);await expect(action(other,'adopt')).toBeEnabled();
  119 |   await other.evaluate(key=>{const j=JSON.parse(localStorage.getItem(key)!);j.confirm={request_id:'other-page-confirmation',quote_hash:j.quote.quote.quote_hash};localStorage.setItem(key,JSON.stringify(j));},journalKey);
  120 |   await expect(panel(page)).toContainText('另一页面的追加费用记录已有变化');await expect(action(page,'adopt')).toBeDisabled();expect(f.adopts).toEqual([]);
  121 |   await action(page,'adoption-local-reload').click();await expect(action(page,'adopt')).toBeEnabled();expect(f.adopts).toEqual([]);
  122 |   await action(page,'adopt').click();await expect(panel(page)).toContainText('补料已采用');expect(f.confirms[0].request_id).toBe('other-page-confirmation');expect(f.adopts).toHaveLength(1);
  123 | });
  124 | 
```