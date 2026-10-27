import {expect,test,type BrowserContext,type Locator,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {emptyUpdateDetails,reportingWindow,updateDetailsErrors,type UnifiedAuthoringInput} from '@bondbuddy/contracts';
import {digest,uid} from '../../api/dist/data.js';
import {inputManifestHash} from '../../api/dist/production-rule-pin.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
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

async function sourceBoundM1Fixture():Promise<RealFixture>{
  // Only this test's original queued boundary is seeded. Its project, session,
  // source material and all supplement operations use the actual server.
  // edit_baseline is valid frozen metadata; no previous artifact or model result is invented.
  const details={...emptyUpdateDetails(),authoring_mode:'unified_v1' as const,source_prospectuses:[],
    reporting_cutoff:'2026-09-30',target_reporting_periods:reportingWindow('sse','private','2026-09-30'),
    supplementary_notes:'合成验收：原项目草稿信息应在本轮补料填写后保持不变。'};
  expect(updateDetailsErrors(details)).toEqual([]);
  const project=await real.request('POST','/api/v1/projects',{creation_request_id:uid(),name:'合成 M1 原稿信息隔离验收',kind:'update',
    issuer_name:'合成原项目发行人',market:'sse',offering:'private',update_details:details});
  const projectId=project.project_id as string,sourceBytes=makeSyntheticDocxFixture({text:'Synthetic original input for isolated source-declaration preparation'});
  const material=await real.upload(projectId,'synthetic-source-context-original.docx',sourceBytes,'other','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const basePin={material_id:material.material_id,material_version:material.material_version,sha256:material.sha256};
  const current=await real.request('GET',`/api/v1/projects/${projectId}`);
  const knowledge='Synthetic frozen source-declaration knowledge';
  const authoring:UnifiedAuthoringInput={version:'unified_v1',source_prospectuses:[],requirements:[],
    edit_baseline:{market:'sse',offering:'private',reporting_periods:reportingWindow('sse','private','2024-12-31')},
    knowledge:[{path:'synthetic-source-declaration.md',sha256:digest(knowledge),markdown:knowledge}],
    knowledge_status:'authoring_reference_not_compliance_approval'};
  const manifest={project_kind:'update',name:current.name,draft_revision:current.draft_revision,issuer_name:current.issuer_name,
    market:'sse',offering:'private',update_details:current.update_details,materials:[{...basePin,role:'other'}],authoring};
  const hash=inputManifestHash(manifest),runId=uid(),jobId=uid();
  await real.pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,$3,$4,$5,$6,'[]')`,[projectId,real.owner,current.draft_revision,hash,manifest,JSON.stringify(manifest.materials)]);
  await real.pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  await real.pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued')`,[runId,real.owner,projectId,hash,uid(),digest(uid())]);
  await real.pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,user_pause_requested,checkpoint)
    VALUES($1,$2,$3,'update','default','queued','queued',false,$4)`,[jobId,real.owner,runId,{synthetic_original_checkpoint:'seeded queued boundary with edit_baseline metadata'}]);
  return {surface:'m1',projectId,sourceProject:projectId,basePin,sourceBytes,runId,jobId,topic:undefined,manifest,hash,route:`/#/projects/${projectId}?run=${runId}`};
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
  test.setTimeout(60000);await page.setViewportSize({width:1440,height:960});await auth(context);const f=await real.fixture(surface,false,true);
  await openPaused(page,f);await real.verifyBytes({projectId:f.sourceProject},f.basePin,f.sourceBytes);
  const {panel,material}=await add(page,f,`synthetic-${surface}-supplement.txt`,`Synthetic supplemental evidence ${surface}`);
  const before=await real.evidence(f);expect((before as any).creditEvents.length).toBeGreaterThan(0);expect((before as any).balance).toEqual({available:10000,frozen:0});
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
  await action(panel,'save').click();const response=await saved;expect(response.status()).toBe(200);expect(response.request().headers()['x-bb-csrf']).toBe(real.csrf);const receipt=await response.json();
  expect(receipt).toMatchObject({revision:1,adopted:false,base_input_revision:1,base_input_hash:f.hash,changes:[{replaces:null,material:{material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}}]});
  expect(receipt.input_preview).toMatchObject({compiler_version:'run-supplement-input-v1',status:'prepared',issues:[]});
  expect(receipt.input_preview.candidate_input_hash).toMatch(/^[a-f0-9]{64}$/);expect(receipt.input_preview.candidate_input_hash).not.toBe(f.hash);
  await expect(panel.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  await expect(panel).toContainText('草稿已保存');preparationOnly(f,before,await real.evidence(f),[receipt]);
  expect((await real.pool.query("SELECT payload FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.supplement_draft_saved'",[f.runId])).rows).toHaveLength(1);
  await page.reload();const restored=await ready(page,f);await expect(restored).toContainText(material.filename);await expect(restored).toContainText('尚未采用');await expect(action(restored,'save')).toBeDisabled();
  await expect(restored.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
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

test('real main: a new prospectus is saved while its missing source declaration stays explicit',async({page,context})=>{
  test.setTimeout(60000);await page.setViewportSize({width:1440,height:960});await auth(context);
  const f=await real.fixture('m1',false,true),panel=await openPaused(page,f);
  await panel.locator('[data-supplement-role]').selectOption('historical');
  const completed=page.waitForResponse(r=>r.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname));
  await panel.locator('[data-supplement-file]').setInputFiles({name:'synthetic-new-prospectus.docx',
    mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:f.sourceBytes});
  const uploaded=await completed;expect(uploaded.status()).toBe(200);const material=await uploaded.json();
  await expect(action(panel,'save')).toBeEnabled();await real.verifyBytes({projectId:f.projectId},material,f.sourceBytes);
  const before=await real.evidence(f);await action(panel,'save').click();
  await expect(panel.locator('[data-supplement-input-preview]')).toContainText('需要重新填写这份原稿的信息');
  await expect(panel.locator('[data-supplement-input-preview]')).not.toContainText('材料关联已核对');
  const receipt=await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`);
  expect(receipt.input_preview).toMatchObject({status:'needs_information',candidate_input_hash:null,
    issues:[{code:'source_information_required',material_id:material.material_id}]});
  preparationOnly(f,before,await real.evidence(f),[receipt]);
  await page.reload();await expect((await ready(page,f)).locator('[data-supplement-input-preview]')).toContainText('需要重新填写这份原稿的信息');
  await expect(action(host(page,f),'quote')).toBeDisabled();
  await capture(page,f,'source-information-required');
  await writeFile(join(real.artifactRoot,'source-information-required-assertions.json'),JSON.stringify({synthetic:true,full_main:true,receipt,before,after:await real.evidence(f)},null,2));
});

test('real main M1: complete source fields and explicit baseline discard stay in the supplement receipt without editing the project draft',async({page,context})=>{
  test.setTimeout(60000);await page.setViewportSize({width:1440,height:960});await auth(context);
  const f=await sourceBoundM1Fixture(),panel=await openPaused(page,f);
  expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`)).toMatchObject({source_context:{kind:'m1_authoring',previous_output_bound:true}});
  await panel.locator('[data-supplement-intent]').selectOption('');await panel.locator('[data-supplement-role]').selectOption('historical');
  const newBytes=makeSyntheticDocxFixture({text:'Synthetic newly uploaded historical prospectus with independently declared source scope'});
  const completed=page.waitForResponse(r=>r.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname));
  await panel.locator('[data-supplement-file]').setInputFiles({name:'synthetic-declared-historical.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:newBytes});
  const upload=await completed;expect(upload.status()).toBe(200);const material=await upload.json();
  expect(material.material_id).not.toBe(f.basePin.material_id);await real.verifyBytes({projectId:f.projectId},material,newBytes);
  const editor=panel.locator('[data-supplement-source]');await expect(editor).toBeVisible();
  const before:any=await real.evidence(f),projectWrites:string[]=[];
  expect(before.project[0].update_details.source_prospectuses).toEqual([]);expect(before.attempts).toEqual([]);
  expect(before.creditEvents.length).toBeGreaterThan(0);expect(before.balance).toEqual({available:10000,frozen:0});
  page.on('request',request=>{if(request.method()==='PATCH'&&new URL(request.url()).pathname===`/api/v1/projects/${f.projectId}`)projectWrites.push(request.postData()??'');});
  // Observe real native events at both phases. A source edit must reach the
  // supplement controller, then stop before shared document/ancestor delegates.
  await page.evaluate(runId=>{
    const probe={captured:[] as string[],bubbled:[] as string[]};(window as any).__supplementSourceProbe=probe;
    const observe=(events:string[])=>(event:Event)=>{const target=event.target;
      // paint() can replace the edited control during dispatch; composedPath
      // still identifies its original panel when a missing stop would bubble.
      if(target instanceof HTMLElement&&event.composedPath().some(node=>node instanceof HTMLElement&&node.matches(`[data-run-supplement="${runId}"]`))
        &&(target.hasAttribute('data-source-field')||target.hasAttribute('data-supplement-discard-output')))
        events.push(target.getAttribute('data-source-field')??(target.hasAttribute('data-supplement-discard-output')?'discard':''));};
    document.addEventListener('change',observe(probe.captured),true);document.addEventListener('change',observe(probe.bubbled));
  },f.runId);
  await editor.locator('[data-source-field="relation"]').selectOption('similar_business');
  await editor.locator('[data-source-field="market"]').selectOption('nafmii');
  await editor.locator('[data-source-field="offering"]').selectOption('mtn');
  await editor.locator('[data-source-field="year"]').selectOption('2025');
  await editor.locator('label.quarter').filter({hasText:'6月末'}).click();
  await expect(editor.locator('[data-source-field="quarter"][value="06-30"]')).toBeChecked();
  await expect(editor.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
  await expect(editor.locator('[data-supplement-discard-output]')).not.toBeChecked();
  const declaration={material_id:material.material_id,material_version:material.material_version,sha256:material.sha256,
    issuer_name:null,relation:'similar_business',market:'nafmii',offering:'mtn',reporting_periods:reportingWindow('nafmii','mtn','2025-06-30'),status:'user_asserted'};
  const changes=[{material:{material_id:material.material_id,material_version:material.material_version,sha256:material.sha256},replaces:null,source_prospectus:declaration}];
  const saving=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
  await action(panel,'save').click();const firstResponse=await saving;expect(firstResponse.status()).toBe(200);
  expect(firstResponse.request().headers()['x-bb-csrf']).toBe(real.csrf);expect(firstResponse.request().postDataJSON().changes).toEqual(changes);
  const first=await firstResponse.json();expect(first.changes).toEqual(changes);
  expect(first.input_preview).toMatchObject({status:'needs_information',candidate_input_hash:null,issues:[{code:'source_baseline_choice_required',material_id:material.material_id}]});
  await expect(panel.locator('[data-supplement-input-preview]')).toContainText('明确本次候选输入放弃旧成果关联');
  preparationOnly(f,before,await real.evidence(f),[first]);
  await editor.locator('[data-supplement-discard-output]').check();
  const confirmedChanges=[{...changes[0],discard_previous_output:true}];
  const confirming=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/v1/runs/${f.runId}/supplement-draft`);
  await action(panel,'save').click();const response=await confirming;expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().changes).toEqual(confirmedChanges);
  const receipt=await response.json();expect(receipt).toMatchObject({revision:2,adopted:false,base_input_revision:1,base_input_hash:f.hash,
    source_context:{kind:'m1_authoring',previous_output_bound:true},input_preview:{status:'prepared',issues:[]}});
  expect(receipt.changes).toEqual(confirmedChanges);expect(receipt.input_preview.candidate_input_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.input_preview.candidate_input_hash).not.toBe(f.hash);
  // Main draft autosave debounces for 800 ms. Allow that entire window before
  // proving source controls produced no project PATCH or editable-draft mutation.
  await page.waitForTimeout(1000);expect(projectWrites).toEqual([]);await expect(page.locator('#save-state')).toHaveText('已保存');
  const probe=await page.evaluate(()=>(window as any).__supplementSourceProbe);
  expect(probe.captured).toEqual(['relation','market','offering','year','quarter','discard']);expect(probe.bubbled).toEqual([]);
  const after:any=await real.evidence(f);preparationOnly(f,before,after,[first,receipt]);
  expect(after.input[0].manifest.authoring.edit_baseline).toEqual(f.manifest.authoring.edit_baseline);
  const rows=(await real.pool.query('SELECT revision,changes FROM bb_run_supplement_drafts WHERE run_id=$1 ORDER BY revision',[f.runId])).rows;
  expect(rows).toEqual([{revision:1,changes},{revision:2,changes:confirmedChanges}]);
  await page.reload();const restored=await ready(page,f),source=restored.locator('[data-supplement-source]');
  await expect(source.locator('[data-source-field="relation"]')).toHaveValue('similar_business');
  await expect(source.locator('[data-source-field="market"]')).toHaveValue('nafmii');await expect(source.locator('[data-source-field="offering"]')).toHaveValue('mtn');
  await expect(source.locator('[data-source-field="year"]')).toHaveValue('2025');await expect(source.locator('[data-source-field="quarter"][value="06-30"]')).toBeChecked();
  await expect(source.locator('[data-supplement-discard-output]')).toBeChecked();await expect(action(restored,'save')).toBeDisabled();
  const baselineLayout=await source.locator('.run-supplement-baseline-choice').evaluate(label=>{
    const checkbox=label.querySelector('input')!,text=label.querySelector('span')!;
    const rect=(element:Element)=>{const {x,y,width,height}=element.getBoundingClientRect();return {x,y,width,height};};
    return {checkbox:rect(checkbox),text:rect(text),label:rect(label)};
  });
  expect(baselineLayout.checkbox.width).toBeGreaterThanOrEqual(12);expect(baselineLayout.checkbox.width).toBeLessThanOrEqual(24);
  expect(baselineLayout.checkbox.height).toBeGreaterThanOrEqual(12);expect(baselineLayout.checkbox.height).toBeLessThanOrEqual(24);
  expect(baselineLayout.text.width).toBeGreaterThan(200);expect(baselineLayout.label.height).toBeLessThanOrEqual(64);
  expect(baselineLayout.text.x+baselineLayout.text.width).toBeLessThanOrEqual(baselineLayout.label.x+baselineLayout.label.width+1);
  await expect(restored.locator('[data-supplement-input-preview]')).toContainText('材料关联已核对');
  await expect(action(restored,'quote')).toBeEnabled();
  expect(await real.request('GET',`/api/v1/runs/${f.runId}/supplement-draft`)).toMatchObject({revision:2,adopted:false,changes:confirmedChanges});
  preparationOnly(f,before,await real.evidence(f),[first,receipt]);expect(projectWrites).toEqual([]);
  await capture(page,f,'source-declaration-isolated');
  await writeFile(join(real.artifactRoot,'m1-source-declaration-isolated-assertions.json'),JSON.stringify({synthetic:true,full_main:true,
    original_boundary:'Seeded queued input with valid edit_baseline metadata; no model execution or previous output artifact is claimed',
    first,receipt,probe,projectWrites,baselineLayout,before,after:await real.evidence(f)},null,2));
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
