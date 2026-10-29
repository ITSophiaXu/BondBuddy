import {expect,test,type Page,type Route} from '@playwright/test';
import {AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,commerceMetadata} from '@bondbuddy/contracts';
import {fixture as qaFixture,install as installQa,projectId as qaProject,ownerId as qaOwner} from './project-qa-continuation-fixtures';
import {fixture as integrityFixture,install as installIntegrity,projectId as integrityProject} from './integrity-continuation-fixtures';
import {fixture as consistencyFixture,install as installConsistency,ids,base,checkId,fileIds} from './consistency-confirmation-fixtures';
import {fixture as reviewFixture,install as installReview,projectId as reviewProject,hash as reviewHash,now as reviewNow} from './review-followup-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';

const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,json:fixtureBody(route,body)});
// Validate the real HTTP wire while preserving decimal strings in captured requests.
const rawRequest=(route:Route)=>{fixtureRequest(route.request());return route.request().postDataJSON();};
const quote=(points:number)=>({...commerceMetadata(points),auto_charge:true,price_version:AUTOMATIC_PRICE_VERSION,points,quote_status:'ready' as const,scope_quote_id:'scope-automatic',scope_lines:[]});
const price=()=>({...quote(0),version:AUTOMATIC_PRICE_VERSION,quote_status:'pending_scope' as const});
async function commerce(page:Page){await page.route('**/api/v1/commerce/**',route=>json(route,{enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'pay_as_you_go',items:[],rules:[]}));}

test('independent full review uses its locked points quote and executes once without a price confirmation',async({page})=>{
  const state=reviewFixture();await installReview(page,state);await commerce(page);const quotes:any[]=[];
  const points=AUTOMATIC_TASK_TARIFF.full_review.points;
  const reviewQuote={...quote(points),quote_id:'independent-full-review-quote',project_id:reviewProject,input_revision:state.draft.version,input_hash:reviewHash('locked full-review input'),task_type:'full_review',reason:'独立全面复核',created_at:reviewNow};
  await page.route(`**/api/v1/projects/${reviewProject}/review-executions/quote`,route=>{quotes.push(rawRequest(route));return json(route,{enabled:true,quote:reviewQuote,balance:{available:55000,frozen:0},shortage:0,reason:null});});
  await page.route('**/api/v1/runs/followup-run-3/credit-charge',route=>json(route,{quote:reviewQuote,state:'held'}));
  await page.goto(`/#/projects/${reviewProject}/review?tab=materials`);
  await page.getByRole('button',{name:'开始复核',exact:true}).click();
  await expect.poll(()=>state.executions.length).toBe(1);expect(quotes).toHaveLength(1);
  expect(state.executions[0]).toMatchObject({operation:'full_review',quote_id:'independent-full-review-quote',expected_input_version:state.draft.version});
  await expect(page.getByRole('dialog',{name:'确认本次任务费用',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'确认总价并开始',exact:true})).toHaveCount(0);
  await expect(page.locator('#review-making-panel')).toContainText(points.toLocaleString('zh-CN')+' 积分');
  expect(state.executions).toHaveLength(1);
});

test('QA one business click submits exactly once without an amount confirmation',async({page})=>{
  const state=qaFixture();state.workspace.price=price();state.workspace.draft.materials.push(structuredClone(state.workspace.prospectus!.asset));await installQa(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,quote(1218)));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(rawRequest(route));return json(route,{run_id:'automatic-qa'});});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:'1218',scope_quote_id:'scope-automatic'});await expect(page.locator('#qa-confirm,[data-commerce-confirm]')).toHaveCount(0);
});

for(const priceVersion of [AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION])test(`QA uncertain ${priceVersion} task keeps points in its durable recovery panel`,async({page})=>{
  const state=qaFixture();state.workspace.price={...price(),version:priceVersion,price_version:priceVersion};state.workspace.draft.materials.push(structuredClone(state.workspace.prospectus!.asset));
  await installQa(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,{...quote(1218),price_version:priceVersion}));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(rawRequest(route));return json(route,{code:'DATA_UNAVAILABLE'},503);});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();
  await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0].expected_points).toBe('1218');
  await expect(page.locator('.qa-recovery')).toContainText('1,218 积分');
  await expect(page.locator('.qa-recovery')).not.toContainText('¥12.18');
  await page.reload();
  await expect(page.locator('.qa-recovery')).toContainText('1,218 积分');
  await expect(page.locator('.qa-recovery')).not.toContainText('¥12.18');
  expect(starts).toHaveLength(1);
  await expect(page.locator('#qa-confirm,[data-commerce-confirm]')).toHaveCount(0);
});

test('integrity starts once from its business action and keeps the immutable revision',async({page})=>{
  const state=integrityFixture();state.workspace.price=price();await installIntegrity(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${integrityProject}/integrity/quote`,route=>json(route,quote(22738)));
  await page.route(`**/api/v1/projects/${integrityProject}/integrity/runs`,route=>{starts.push(rawRequest(route));return json(route,{run_id:'automatic-integrity'});});
  await page.goto(`/#integrity?project=${integrityProject}`);await page.locator('#integrity-start').click();await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:'22738'});await expect(page.locator('#integrity-confirm')).toHaveCount(0);
});

test('consistency updates directly after selection, including zero-cost included scope',async({page})=>{
  const state=consistencyFixture();await installConsistency(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1${base}/checks/${checkId}/updates/quote`,route=>{const files=rawRequest(route).files;return json(route,{points:0,price_version:AUTOMATIC_PRICE_VERSION,quote_status:'ready',items:files.map((file:any)=>({...quote(0),file_version_id:file.file_version_id}))});});
  await page.route(`**/api/v1${base}/checks/${checkId}/updates`,route=>{starts.push(rawRequest(route));return json(route,{batch_id:'automatic-update'});});
  await page.goto(`/#consistency?project=${ids.root}&run=${checkId}`);await page.locator(`[data-fc-select="${fileIds.issuer}"]`).check();await page.locator('#fc-accept-top').click();
  await expect.poll(()=>starts.length).toBe(1);expect(starts[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:'0'});await expect(page.locator('#fc-confirm-update')).toHaveCount(0);
});

test('insufficient balance preserves only the original task and payment return replays its exact key and body',async({page})=>{
  const state=qaFixture();state.workspace.price=price();state.workspace.draft.materials.push(structuredClone(state.workspace.prospectus!.asset));await installQa(page,state);await commerce(page);const starts:any[]=[],rawStarts:string[]=[],payments:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,quote(1218)));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(rawRequest(route));rawStarts.push(route.request().postData()!);return starts.length===1?json(route,{code:'CREDITS_INSUFFICIENT'},402):json(route,{run_id:'paid-original'});});
  await page.route('**/api/v1/subscriptions',route=>{payments.push(rawRequest(route));return json(route,{code:'MUST_NOT_PAY'},500);});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();await expect(page.locator('#billing-task-notice')).toContainText('原任务尚未开始');expect(payments).toEqual([]);expect(starts).toHaveLength(1);
  // The subscription page supplies this same validated return route only after a paid order.
  const rechargeHref=await page.locator('#billing-task-notice').getByRole('link',{name:'订阅或充值，继续原任务',exact:true}).getAttribute('href');
  expect(rechargeHref).toBeTruthy();const resumeRequest=new URLSearchParams(rechargeHref!.split('?')[1]).get('resume_request');expect(resumeRequest).toMatch(/^[a-f0-9]{64}$/);
  const saved=await page.evaluate(async({owner,id})=>{const recovery=await import('/src/'+'billing-task-recovery.ts');return {task:await recovery.readBillingTask(owner,id),returnTo:await recovery.billingTaskReturnTo(owner,id)};},{owner:qaOwner,id:resumeRequest!});
  expect(saved.task).toMatchObject({version:2,owner:qaOwner,id:resumeRequest,state:'needs_funds',requiredPoints:'1218',body:starts[0]});
  expect(saved.returnTo).toBeTruthy();await page.goto('/'+saved.returnTo);await expect.poll(()=>starts.length).toBe(2);expect(starts[1]).toEqual(starts[0]);expect(starts[0].expected_points).toBe('1218');expect(rawStarts[1]).toBe(rawStarts[0]);
  await page.reload();await expect(page.locator('#qa-start')).toBeVisible();expect(starts).toHaveLength(2);expect(payments).toEqual([]);
});
