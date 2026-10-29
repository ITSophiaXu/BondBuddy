import {expect,test,type Page,type Route} from '@playwright/test';
import {AUTOMATIC_PRICE_VERSION,commerceMetadata} from '@bondbuddy/contracts';
import {fixture as qaFixture,install as installQa,projectId as qaProject} from './project-qa-continuation-fixtures';
import {fixture as integrityFixture,install as installIntegrity,projectId as integrityProject} from './integrity-continuation-fixtures';
import {fixture as consistencyFixture,install as installConsistency,ids,base,checkId,fileIds} from './consistency-confirmation-fixtures';

const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,json:body});
const quote=(points:number)=>({...commerceMetadata(points),auto_charge:true,price_version:AUTOMATIC_PRICE_VERSION,points,quote_status:'ready' as const,scope_quote_id:'scope-automatic',scope_lines:[]});
const price=()=>({...quote(0),version:AUTOMATIC_PRICE_VERSION,quote_status:'pending_scope' as const});
async function commerce(page:Page){await page.route('**/api/v1/commerce/**',route=>json(route,{enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'pay_as_you_go',items:[],rules:[]}));}

test('QA one business click submits exactly once without an amount confirmation',async({page})=>{
  const state=qaFixture();state.workspace.price=price();state.workspace.draft.materials.push(structuredClone(state.workspace.prospectus!.asset));await installQa(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,quote(1218)));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(route.request().postDataJSON());return json(route,{run_id:'automatic-qa'});});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:1218,scope_quote_id:'scope-automatic'});await expect(page.locator('#qa-confirm,[data-commerce-confirm]')).toHaveCount(0);
});

test('integrity starts once from its business action and keeps the immutable revision',async({page})=>{
  const state=integrityFixture();state.workspace.price=price();await installIntegrity(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${integrityProject}/integrity/quote`,route=>json(route,quote(22738)));
  await page.route(`**/api/v1/projects/${integrityProject}/integrity/runs`,route=>{starts.push(route.request().postDataJSON());return json(route,{run_id:'automatic-integrity'});});
  await page.goto(`/#integrity?project=${integrityProject}`);await page.locator('#integrity-start').click();await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:22738});await expect(page.locator('#integrity-confirm')).toHaveCount(0);
});

test('consistency updates directly after selection, including zero-cost included scope',async({page})=>{
  const state=consistencyFixture();await installConsistency(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1${base}/checks/${checkId}/updates/quote`,route=>{const files=route.request().postDataJSON().files;return json(route,{points:0,price_version:AUTOMATIC_PRICE_VERSION,quote_status:'ready',items:files.map((file:any)=>({...quote(0),file_version_id:file.file_version_id}))});});
  await page.route(`**/api/v1${base}/checks/${checkId}/updates`,route=>{starts.push(route.request().postDataJSON());return json(route,{batch_id:'automatic-update'});});
  await page.goto(`/#consistency?project=${ids.root}&run=${checkId}`);await page.locator(`[data-fc-select="${fileIds.issuer}"]`).check();await page.locator('#fc-accept-top').click();
  await expect.poll(()=>starts.length).toBe(1);expect(starts[0]).toMatchObject({price_version:AUTOMATIC_PRICE_VERSION,expected_points:0});await expect(page.locator('#fc-confirm-update')).toHaveCount(0);
});

test('insufficient balance preserves only the original task and payment return replays its exact key and body',async({page})=>{
  const state=qaFixture();state.workspace.price=price();state.workspace.draft.materials.push(structuredClone(state.workspace.prospectus!.asset));await installQa(page,state);await commerce(page);const starts:any[]=[],payments:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,quote(1218)));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(route.request().postDataJSON());return starts.length===1?json(route,{code:'CREDITS_INSUFFICIENT'},402):json(route,{run_id:'paid-original'});});
  await page.route('**/api/v1/subscriptions',route=>{payments.push(route.request().postDataJSON());return json(route,{code:'MUST_NOT_PAY'},500);});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();await expect(page.locator('#billing-task-notice')).toContainText('原任务尚未开始');expect(payments).toEqual([]);expect(starts).toHaveLength(1);
  // The subscription page supplies this same validated return route only after a paid order.
  const returnTo=await page.evaluate(async()=>{const row=Object.keys(localStorage).find(k=>k.startsWith('bondbuddy:billing-task:v1:'))!,record=JSON.parse(localStorage.getItem(row)!);const recovery=await import('/src/'+'billing-task-recovery.ts');return recovery.billingTaskReturnTo(record.owner,record.id);});
  expect(returnTo).toBeTruthy();await page.goto('/'+returnTo);await expect.poll(()=>starts.length).toBe(2);expect(starts[1]).toEqual(starts[0]);
  await page.reload();await expect(page.locator('#qa-start')).toBeVisible();expect(starts).toHaveLength(2);expect(payments).toEqual([]);
});
