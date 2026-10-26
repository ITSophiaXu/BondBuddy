import {expect,test,type BrowserContext,type Locator,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startRealSupplement,type RealFixture,type RealSurface} from './run-supplement-real-harness';

let real:Awaited<ReturnType<typeof startRealSupplement>>;
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{real=await startRealSupplement();});
test.afterAll(async()=>{await real?.close();});
const action=(host:Locator,name:string)=>host.locator(`[data-supplement-action="${name}"]`);
const host=(page:Page,f:RealFixture)=>page.locator(`[data-run-supplement="${f.runId}"]`);
const control=(page:Page,f:RealFixture,name:'pause'|'resume')=>f.surface==='m1'?page.locator(`#${name}-run`):f.surface==='m3'?page.locator(`#review-making-panel [data-review-action="${name}"]`):page.locator(`[data-m4-action="${name}"][data-run="${f.runId}"]`);
async function auth(context:BrowserContext){
  await context.addCookies([{name:'bb_session',value:real.access,url:real.baseURL,httpOnly:true,sameSite:'Lax'},{name:'bb_csrf',value:real.csrf,url:real.baseURL,sameSite:'Lax'}]);
  // Requests use the real server. No API response fixture or synthetic page shell is installed.
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==real.baseURL)throw new Error(`Unexpected external request: ${url.origin}`);await route.continue();});
}
async function ready(page:Page,f:RealFixture){
  const panel=host(page,f);await expect(panel).toBeVisible();
  const summary=panel.locator('summary').first();
  if(await summary.count()){const details=summary.locator('..');if(await details.evaluate(e=>e.tagName==='DETAILS'&&!(e as HTMLDetailsElement).open))await summary.click();}
  await expect(panel.locator('[data-supplement-file]')).toBeVisible();return panel;
}
async function openPaused(page:Page,f:RealFixture){
  await page.goto(real.baseURL+f.route);
  await expect(control(page,f,'pause')).toBeVisible();
  const paused=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/pause`);
  await control(page,f,'pause').click();expect((await paused).status()).toBe(200);
  await expect.poll(async()=>(await real.pool.query('SELECT state FROM bb_runs WHERE id=$1',[f.runId])).rows[0].state).toBe('paused');
  return ready(page,f);
}
async function add(page:Page,f:RealFixture,name:string,text:string){
  const panel=await ready(page,f);await panel.locator('[data-supplement-intent]').selectOption('');await panel.locator('[data-supplement-role]').selectOption('audit');
  const completed=page.waitForResponse(r=>r.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname));
  await panel.locator('[data-supplement-file]').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(text)});
  const response=await completed;expect(response.status()).toBe(200);const material=await response.json();
  await expect(action(panel,'save')).toBeEnabled();await real.verifyBytes({projectId:f.projectId},material,Buffer.from(text));return {panel,material};
}
async function capture(page:Page,f:RealFixture,suffix='saved'){
  await mkdir(real.artifactRoot,{recursive:true});await host(page,f).scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:join(real.artifactRoot,`${f.surface}-${suffix}-viewport.png`)});
  await page.screenshot({path:join(real.artifactRoot,`${f.surface}-${suffix}-full.png`),fullPage:true});
}
function preparationOnly(f:RealFixture,before:any,after:any,receipts:Array<{request_id:string;revision:number}>){
  const {outbox:oldEvents,...oldState}=before,{outbox:newEvents,...newState}=after;
  expect(newState).toEqual(oldState);
  const oldIds=new Set(oldEvents.map((event:any)=>event.id));
  for(const event of oldEvents)expect(newEvents.find((next:any)=>next.id===event.id),'Every prior outbox row remains exact').toEqual(event);
  const added=newEvents.filter((event:any)=>!oldIds.has(event.id));expect(added).toHaveLength(receipts.length);
  for(const receipt of receipts){
    const matches=added.filter((event:any)=>event.payload?.request_id===receipt.request_id);expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({owner_user_id:real.owner,aggregate_type:'run_supplement_draft',aggregate_id:f.runId,event_type:'run.supplement_draft_saved'});
    expect(matches[0].payload).toEqual({run_id:f.runId,project_id:f.projectId,revision:receipt.revision,request_id:receipt.request_id,base_input_revision:before.run[0].input_revision,base_input_hash:f.hash,adopted:false});
  }
}
function resumedSameJob(f:RealFixture,before:any,after:any){
  const identities=(jobs:any[])=>jobs.map(({id,run_id})=>({id,run_id}));
  expect(identities(after.ownerJobs)).toEqual(identities(before.ownerJobs));
  for(const previous of before.ownerJobs){
    const current=after.ownerJobs.find((job:any)=>job.id===previous.id);
    if(previous.id!==f.jobId){expect(current,'Only the original target job may change on resume').toEqual(previous);continue;}
    expect(current).toMatchObject({id:f.jobId,run_id:f.runId,state:'queued',stage:'queued',user_pause_requested:false,lease_token:null,lease_until:null});
    const stable=({state:_state,stage:_stage,user_pause_requested:_pause,updated_at:_updated,...rest}:any)=>rest;
    expect(stable(current),'Original job identity, checkpoint and attempts remain exact').toEqual(stable(previous));
  }
  expect(after.ownerJobs.filter((job:any)=>job.id===f.jobId&&job.run_id===f.runId)).toHaveLength(1);
}

// Keep this first: its real queue claim must select the newly created source review,
// before the normal journeys intentionally leave other original tasks queued.
test('real main M3 review-updates: actual creation shape saves preparation and resumes the same original revision',async({page,context})=>{
  test.setTimeout(60000);await page.setViewportSize({width:1440,height:960});await auth(context);const f=await real.fixture('m3',true);
  await openPaused(page,f);const {panel,material}=await add(page,f,'synthetic-review-update-supplement.txt','Synthetic supplement for actual review-updates task');
  const before:any=await real.evidence(f);expect(before.run[0].input_revision).toBe(2);expect(before.review[0].operation).toBe('revision');
  await action(panel,'save').click();await expect(panel).toContainText('草稿已保存');
  const receipt=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`);expect(receipt).toMatchObject({revision:1,adopted:false,base_input_revision:2,base_input_hash:f.hash,changes:[{material:{material_id:material.material_id}}]});
  preparationOnly(f,before,await real.evidence(f),[receipt]);
  await page.reload();await expect(await ready(page,f)).toContainText(material.filename);await capture(page,f,'review-update-saved');
  await control(page,f,'resume').click();await expect(page.locator('.run-supplement-resume-dialog')).toBeVisible();
  const resumed=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/resume`);
  await page.locator('[data-supplement-resume-confirm]').click();expect((await resumed).status()).toBe(200);
  const after:any=await real.evidence(f);expect(after.run[0]).toMatchObject({id:f.runId,state:'queued',input_revision:2,input_hash:f.hash,execution_request_id:before.run[0].execution_request_id});
  resumedSameJob(f,before,after);
  for(const key of ['input','reviewDraft','review','m4Draft','m4','attempts','creditEvents','reservations','lots','creditAccount','balance'])expect(after[key],key).toEqual(before[key]);
  await writeFile(join(real.artifactRoot,'m3-review-update-assertions.json'),JSON.stringify({synthetic:true,source_result:'synthetic DOCX through real artifact promotion and finish; no supplier called',target_created_by:'POST review-updates',receipt,before,after},null,2));
});

for(const surface of ['m1','m3','m4'] as RealSurface[])test(`real main ${surface}: browser pause, private-byte upload, save, reload and same-run original-material resume`,async({page,context})=>{
  test.setTimeout(60000);await page.setViewportSize({width:1440,height:960});await auth(context);const f=await real.fixture(surface);
  await openPaused(page,f);await real.verifyBytes({projectId:f.sourceProject},f.basePin,f.sourceBytes);
  const {panel,material}=await add(page,f,`synthetic-${surface}-supplement.txt`,`Synthetic supplemental evidence ${surface}`);
  const before=await real.evidence(f);expect((before as any).creditEvents.length).toBeGreaterThan(0);expect((before as any).balance).toEqual({available:10000,frozen:0});
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
  await action(panel,'save').click();const response=await saved;expect(response.status()).toBe(200);expect(response.request().headers()['x-bb-csrf']).toBe(real.csrf);const receipt=await response.json();
  expect(receipt).toMatchObject({revision:1,adopted:false,base_input_revision:1,base_input_hash:f.hash,changes:[{replaces:null,material:{material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}}]});
  await expect(panel).toContainText('草稿已保存');preparationOnly(f,before,await real.evidence(f),[receipt]);
  expect((await real.pool.query("SELECT payload FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.supplement_draft_saved'",[f.runId])).rows).toHaveLength(1);
  await page.reload();const restored=await ready(page,f);await expect(restored).toContainText(material.filename);await expect(restored).toContainText('尚未采用');await expect(action(restored,'save')).toBeDisabled();
  await capture(page,f);await control(page,f,'resume').click();const dialog=page.locator('.run-supplement-resume-dialog');await expect(dialog).toBeVisible();await expect(dialog).toContainText('原材料');
  expect((await real.pool.query('SELECT state FROM bb_runs WHERE id=$1',[f.runId])).rows[0].state).toBe('paused');
  await dialog.locator('[data-supplement-resume-cancel]').click();await control(page,f,'resume').click();
  const resumed=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/resume`);
  await page.locator('[data-supplement-resume-confirm]').click();expect((await resumed).status()).toBe(200);
  const after:any=await real.evidence(f);expect(after.run[0]).toMatchObject({id:f.runId,input_revision:1,input_hash:f.hash,state:'queued',execution_request_id:(before as any).run[0].execution_request_id});
  resumedSameJob(f,before,after);
  for(const key of ['input','reviewDraft','review','m4Draft','m4','attempts','creditEvents','reservations','lots','creditAccount','balance'])expect(after[key],key).toEqual((before as any)[key]);
  expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft?request_id=${receipt.request_id}`)).toMatchObject({revision:1,adopted:false,can_save:false});
  await writeFile(join(real.artifactRoot,`${surface}-assertions.json`),JSON.stringify({synthetic:true,full_main:true,manual_pause:'real browser POST from seeded queued run; no model-save pause claimed',run_id:f.runId,input_hash:f.hash,receipt,before,after},null,2));
});

test('real main M3: accepted save response loss recovers the exact PostgreSQL receipt without a second PUT',async({page,context})=>{
  test.setTimeout(60000);await page.setViewportSize({width:1440,height:960});await auth(context);const f=await real.fixture('m3');await openPaused(page,f);const {panel}=await add(page,f,'synthetic-lost-receipt.txt','Synthetic actual accepted PUT response loss');
  const before=await real.evidence(f);let puts=0,requestId='';const receipts:string[]=[];
  page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname.endsWith('/supplement-draft')){const id=new URL(request.url()).searchParams.get('request_id');if(id)receipts.push(id);}});
  await page.route(`**/api/v1/runs/${f.runId}/supplement-draft`,async route=>{
    if(route.request().method()!=='PUT'){await route.continue();return;}puts++;requestId=route.request().postDataJSON().request_id;
    const actual=await route.fetch();expect(actual.status()).toBe(200);expect((await actual.json()).request_id).toBe(requestId);await route.abort('failed');
  });
  await action(panel,'save').click();await expect(panel).toContainText('草稿已保存');expect(puts).toBe(1);expect(receipts).toContain(requestId);
  expect((await real.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1',[f.runId])).rows[0].n).toBe(1);preparationOnly(f,before,await real.evidence(f),[{request_id:requestId,revision:1}]);
  expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft?request_id=${requestId}`)).toMatchObject({request_id:requestId,revision:1,adopted:false});await capture(page,f,'receipt-recovered');
});

test('real main M4: independent browser contexts preserve conflicting edits until explicit CAS resolution',async({browser})=>{
  test.setTimeout(60000);const first=await browser.newContext({viewport:{width:1440,height:960}}),second=await browser.newContext({viewport:{width:1440,height:960}});
  try{
    await auth(first);await auth(second);const a=await first.newPage(),b=await second.newPage(),f=await real.fixture('m4');await openPaused(a,f);
    await b.goto(real.baseURL+f.route);await ready(b,f);const x=await add(a,f,'synthetic-first.txt','Synthetic first context'),y=await add(b,f,'synthetic-conflicting.txt','Synthetic second context');
    const before=await real.evidence(f);await action(x.panel,'save').click();await expect(x.panel).toContainText('草稿已保存');const initial=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`);preparationOnly(f,before,await real.evidence(f),[initial]);
    const conflict=b.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
    await action(y.panel,'save').click();expect((await conflict).status()).toBe(409);await expect(action(y.panel,'keep-local')).toBeVisible();await expect(y.panel).toContainText('synthetic-conflicting.txt');
    expect((await real.pool.query('SELECT count(*)::int n FROM bb_run_supplement_drafts WHERE run_id=$1',[f.runId])).rows[0].n).toBe(1);
    await action(y.panel,'keep-local').click();await expect(y.panel).toContainText('synthetic-conflicting.txt');
    await action(y.panel,'save').click();await expect(y.panel.locator('[data-supplement-saved]')).toContainText('V2');
    const current=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`);expect(current).toMatchObject({revision:2,adopted:false,changes:[{material:{material_id:y.material.material_id}}]});
    preparationOnly(f,before,await real.evidence(f),[initial,current]);await b.reload();await expect(await ready(b,f)).toContainText('synthetic-conflicting.txt');await capture(b,f,'cas-resolved');
  }finally{await first.close();await second.close();}
});
