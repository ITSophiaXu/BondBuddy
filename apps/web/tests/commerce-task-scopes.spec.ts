import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test,type Page,type Route} from '@playwright/test';
import {commerceMetadata,OUTCOME_PRICE_VERSION,type ScopeLine} from '@bondbuddy/contracts';
import {fixture as continuationFixture,install as installQa,projectId as qaProject,answerId,oldArtifact} from './project-qa-continuation-fixtures';
import {fixture as integrityFixture,install as installIntegrity,projectId as integrityProject} from './integrity-continuation-fixtures';
import {fixture as consistencyFixture,install as installConsistency,ids,base,checkId,fileIds} from './consistency-confirmation-fixtures';

import {fixtureJson,fixtureRequest} from './billing-fixture-wire';

// Historical CNY scope quotes remain supported; these are not new subscription tasks.
// The current prospectus must be selected before a pricing scenario can start.
function qaFixture(){const state=continuationFixture();state.workspace.draft.materials.push(structuredClone(oldArtifact));return state;}

// Synthetic public HTTP responses exercise monetary admission and immutable scope,
// never supplier calls, document quality, actual balances or merchant settlement.
const line=(amount:number):ScopeLine=>({key:'scope-business',label:'核对两项业务依据及关联披露',quantity:2,unit:'项',unit_price_fen:amount/2,amount_fen:amount,evidence:['用户确认问题与材料版本；两项独立业务依据。']});
const quote=(amount:number,ready:boolean,id='scope-synthetic')=>({...commerceMetadata(amount),points:amount,price_version:OUTCOME_PRICE_VERSION,quote_status:ready?'ready' as const:'pending_scope' as const,scope_quote_id:id,scope_lines:ready&&amount?[line(amount)]:[]});
const workspacePrice=()=>({version:OUTCOME_PRICE_VERSION,points:0,...commerceMetadata(0),quote_status:'pending_scope' as const,scope_lines:[]});
async function evidence(page:Page,name:string,fullPage=true){const directory=process.env.BB_UX_EVIDENCE_DIR;if(!directory)return;await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,name),fullPage});}
test.beforeEach(async({page})=>page.setViewportSize({width:1440,height:960}));
const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:fixtureJson(route,body)});
async function commerce(page:Page){await page.route('**/api/v1/commerce/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/catalog'))return json(route,{enabled:true,currency:'CNY',version:OUTCOME_PRICE_VERSION,model:'pay_as_you_go',items:[],rules:[]});
  if(path.endsWith('/account'))return json(route,{available_fen:100000,held_fen:0,payment_enabled:false,providers:[],legacy_balance_notice:''});
  return json(route,{code:'NOT_FOUND'},404);
});}

test('QA pending scope cannot run; ready quote total and work items survive cancellation and confirmation',async({page})=>{
  const state=qaFixture();state.workspace.price=workspacePrice();await installQa(page,state);await commerce(page);
  let ready=false;const starts:any[]=[],quoted:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>{quoted.push(fixtureRequest(route.request()));return json(route,quote(ready?12340:0,ready));});
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(fixtureRequest(route.request()));return json(route,{run_id:'commercial-qa-run'});});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();
  await expect(page.getByRole('heading',{name:'范围报价待确认',exact:true})).toBeVisible();await expect(page.locator('#qa-confirm')).toHaveCount(0);expect(starts).toEqual([]);
  ready=true;await page.locator('#qa-refresh-scope').click();await expect(page.locator('#qa-confirm')).toContainText('¥123.40');
  await expect(page.locator('.qa-modal[open] [aria-label="本次范围报价明细"]')).toContainText('两项业务依据');await evidence(page,'qa-scope-confirmation-1440.png',false);
  await page.locator('.qa-modal[open] [data-close]').click();expect(starts).toEqual([]);
  await page.locator('#qa-start').click();await page.locator('#qa-confirm').click();await expect.poll(()=>starts.length).toBe(1);
  expect(starts[0]).toMatchObject({expected_points:12340,price_version:OUTCOME_PRICE_VERSION,scope_quote_id:'scope-synthetic'});
  expect(quoted[0]).toEqual(quoted[1]);
});

test('QA original paid scope supplements quote zero; switching to new facts obtains a new total',async({page})=>{
  const state=qaFixture(),paid=state.workspace.runs.find(run=>run.run_id===answerId)!;
  Object.assign(paid.manifest,quote(12340,true,'paid-original'));paid.charged_points=12340;
  const originalQuestions=structuredClone(paid.manifest.questions.filter(q=>paid.result!.answers.find(a=>a.question_id===q.id)?.status==='missing'));
  state.workspace.price=workspacePrice();await installQa(page,state);await commerce(page);
  const requests:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>{const body=fixtureRequest(route.request());requests.push(body);return json(route,quote(body.included_followup_of?0:24680,true,body.included_followup_of?'scope-included':'scope-new-facts'));});
  await page.goto(`/#qa?project=${qaProject}&run=${answerId}`);await page.locator('.qa-followup>summary').click();await page.locator('#qa-continue').click();
  // The approved single-start flow retains use_knowledge:false without a reference-choice control.
  await expect(page.locator('[data-qa-knowledge-choice]')).toHaveCount(0);// The approved 11/09 preparation is a read-only question preview.
  await expect(page.locator('#qa-ranges,[data-remove-q],.qa-range-list')).toHaveCount(0);
  await expect(page.locator('#qa-requirements')).not.toBeEditable();
  await page.locator('#qa-start').click();await expect(page.locator('#qa-confirm')).toContainText('原范围包含／已购覆盖');await expect(page.locator('.qa-modal[open]')).toContainText('无需充值或新增预留');expect(requests[0]).toMatchObject({included_followup_of:answerId});expect(state.drafts.at(-1)?.draft.use_knowledge).toBe(false);expect(state.drafts.at(-1)?.draft.questions).toEqual(originalQuestions);
  await page.locator('.qa-modal[open] [data-close]').click();await page.locator('#qa-new-scope').click();await expect(page.locator('#qa-requirements')).toBeEditable();
  await page.locator('#qa-start').click();await expect(page.locator('#qa-confirm')).toContainText('¥246.80');expect(requests.at(-1)).not.toHaveProperty('included_followup_of');
  expect(state.answers).toEqual([]);
});

test('integrity uses the current roster quote and does not treat the zero placeholder as a free run',async({page})=>{
  const state=integrityFixture();state.workspace.price=workspacePrice();await installIntegrity(page,state);await commerce(page);
  let ready=false;const starts:any[]=[];
  await page.route(`**/api/v1/projects/${integrityProject}/integrity/quote`,route=>json(route,quote(ready?18600:0,ready,'scope-integrity')));
  await page.route(`**/api/v1/projects/${integrityProject}/integrity/runs`,route=>{starts.push(fixtureRequest(route.request()));return json(route,{run_id:'commercial-integrity-run'});});
  await page.goto(`/#integrity?project=${integrityProject}`);await page.locator('#integrity-start').click();await expect(page.locator('#integrity-refresh-scope')).toBeVisible();expect(starts).toEqual([]);
  ready=true;await page.locator('#integrity-refresh-scope').click();await expect(page.locator('#integrity-confirm')).toContainText('¥186.00');await page.locator('#integrity-confirm').click();
  await expect.poll(()=>starts.length).toBe(1);expect(starts[0]).toMatchObject({expected_points:18600,price_version:OUTCOME_PRICE_VERSION,scope_quote_id:'scope-integrity'});
});

test('sync quotes each selected file, blocks a pending item and sends each immutable quote ID once',async({page})=>{
  const state=consistencyFixture();await installConsistency(page,state);await commerce(page);
  let ready=false;const starts:any[]=[];
  await page.route(`**/api/v1${base}/checks/${checkId}/updates/quote`,route=>{const files=fixtureRequest(route.request()).files;return json(route,{points:ready?15800:0,price_version:OUTCOME_PRICE_VERSION,quote_status:ready?'ready':'pending_scope',items:files.map((file:{file_version_id:string},index:number)=>({file_version_id:file.file_version_id,scope_quote_id:'scope-file-'+index,quote_status:ready?'ready':'pending_scope',points:ready?[5800,10000][index]:0,scope_lines:ready?[{key:'reuse-paid',label:'复用本轮已付检查',quantity:1,unit:'份',unit_price_fen:0,amount_fen:0,evidence:['同一募集书及关联文件版本，已有有效付费检查。']},line([5800,10000][index])]:[]}))});});
  await page.route(`**/api/v1${base}/checks/${checkId}/updates`,route=>{starts.push(fixtureRequest(route.request()));return json(route,{batch_id:'commercial-sync-batch'});});
  await page.goto(`/#consistency?project=${ids.root}&run=${checkId}`);await expect(page.locator('.fc-results')).toBeVisible();
  await page.locator(`[data-fc-select="${fileIds.issuer}"]`).check();await page.locator(`[data-fc-select="${fileIds.financial}"]`).check();await page.locator('#fc-accept-top').click();await expect(page.locator('#fc-refresh-scope')).toBeVisible();expect(starts).toEqual([]);
  ready=true;await page.locator('#fc-refresh-scope').click();await expect(page.locator('.fc-confirm-total')).toContainText('¥158.00');await expect(page.locator('.fc-confirm-body')).toContainText('复用本轮已付检查');
  await page.locator('#fc-confirm-update').click();await expect.poll(()=>starts.length).toBe(1);expect(starts[0]).toMatchObject({expected_points:15800,files:[{file_version_id:fileIds.issuer,scope_quote_id:'scope-file-0'},{file_version_id:fileIds.financial,scope_quote_id:'scope-file-1'}]});
});

test('a same-version paid consistency check reuses zero-ready coverage without interpreting pending zero as free',async({page})=>{
  const state=consistencyFixture();await installConsistency(page,state);await commerce(page);
  let ready=false;const starts:any[]=[],topups:any[]=[],versions=state.files.filter(file=>file.latest).map(file=>file.version_id);
  await page.route('**/api/v1/commerce/topups',route=>{topups.push(fixtureRequest(route.request()));return json(route,{code:'MUST_NOT_TOPUP'},500);});
  await page.route(`**/api/v1${base}/checks/quote`,route=>json(route,{...quote(0,ready),file_version_ids:versions,source_version_id:state.source.version_id}));
  await page.route(`**/api/v1${base}/checks`,async route=>{if(route.request().method()!=='POST')return route.fallback();starts.push(fixtureRequest(route.request()));return json(route,{run_id:checkId});});
  await page.goto(`/#consistency?project=${ids.root}&run=${checkId}`);await page.locator('[data-fc-start]').first().click();
  await expect(page.locator('[data-commerce-confirm]')).toContainText('本次范围报价待确认，尚未收费');await expect(page.locator('[data-commerce-accept]')).toHaveCount(0);expect(starts).toEqual([]);
  await page.locator('[data-commerce-back]').click();ready=true;await page.locator('[data-fc-start]').first().click();await expect(page.locator('[data-commerce-confirm]')).toContainText('原范围包含／已购覆盖');await expect(page.locator('[data-commerce-confirm]')).toContainText('无需充值或新增预留');await expect(page.locator('[data-commerce-confirm]')).not.toContainText('未交付部分释放');await expect(page.locator('[data-commerce-accept]')).toHaveText('确认范围并继续');await page.locator('[data-commerce-accept]').click();
  await expect.poll(()=>starts.length).toBe(1);expect(starts[0]).toMatchObject({expected_points:0,price_version:OUTCOME_PRICE_VERSION,expected_source_version_id:state.source.version_id,file_version_ids:versions});
  expect(topups).toEqual([]);
});

for(const status of ['expired','unavailable','declined'] as const)test(`QA ${status} quotation cannot start and preparation remains available`,async({page})=>{
  const state=qaFixture();state.workspace.price=workspacePrice();await installQa(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,{...quote(12340,true),quote_status:status,scope_expires_at:'2020-01-01T00:00:00Z'}));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(fixtureRequest(route.request()));return json(route,{run_id:'must-not-execute'});});
  await page.goto(`/#qa?project=${qaProject}`);const requirement=await page.locator('#qa-requirements').inputValue();await page.locator('#qa-start').click();
  await expect(page.locator('#qa-confirm')).toHaveCount(0);await expect(page.locator('.qa-modal[open]')).toContainText(status==='expired'?'本报价已过期':status==='unavailable'?'暂无法承接':'已拒绝本报价');
  await page.locator('.qa-modal[open] [data-close]').click();await expect(page.locator('#qa-requirements')).toHaveValue(requirement);expect(starts).toEqual([]);
});

test('a ready QA quote that expires while confirming is disabled without a run request',async({page})=>{
  const state=qaFixture();state.workspace.price=workspacePrice();await installQa(page,state);await commerce(page);const starts:any[]=[];
  await page.route(`**/api/v1/projects/${qaProject}/qa/quote`,route=>json(route,{...quote(12340,true),scope_expires_at:new Date(Date.now()+1500).toISOString()}));
  await page.route(`**/api/v1/projects/${qaProject}/qa/runs`,route=>{starts.push(fixtureRequest(route.request()));return json(route,{run_id:'must-not-execute'});});
  await page.goto(`/#qa?project=${qaProject}`);await page.locator('#qa-start').click();await expect(page.locator('#qa-confirm')).toBeEnabled();await expect(page.locator('#qa-confirm')).toBeDisabled({timeout:5000});await expect(page.locator('[data-commerce-expired]')).toContainText('未开始、未扣费');expect(starts).toEqual([]);
});
