import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {sha256} from './support.mjs';

export const ORIGINAL_INTEGRITY_SITE_IDS=['credit-china','execution-dishonest','execution-debtor','csrc','sse'];
export const INTEGRITY_SITE_IDS=['pbc','nfra','csrc','sse','szse'];
export const WORKPAPER_SUBSET=[
 {code:'2-1-4',row:97},{code:'2-3-6',row:117},{code:'2-4-2',row:132},{code:'1-5-7-1',row:79},{code:'1-5-5',row:76},
];
const sameSet=(actual,expected)=>Array.isArray(actual)&&actual.length===expected.length&&new Set(actual).size===actual.length&&expected.every(x=>actual.includes(x));
const id=value=>{assert.equal(typeof value,'string');assert.ok(value.length,'Missing saved identity');return value;};
const field=(name,value)=>`[${name}=${JSON.stringify(String(value))}]`;
const projectBase=entry=>'/api/v1/projects/'+encodeURIComponent(id(entry.projectId));
const sourceFixture=path=>{const bytes=readFileSync(path);assert.ok(bytes.length);return {filename:basename(path),byte_size:bytes.length,sha256:sha256(bytes)};};
const withQuery=(url,values)=>{const u=new URL(url),[route,search='']=u.hash.split('?'),query=new URLSearchParams(search);for(const [key,value] of Object.entries(values))query.set(key,value);u.hash=route+'?'+query;return u.href;};

export function integrityScopeRevision(recipe,sourceRecipeSha256){
 assert.equal(recipe?.case_id,'integrity-dongying');assert.deepEqual(recipe.draft?.site_ids,ORIGINAL_INTEGRITY_SITE_IDS,'Original integrity recipe changed');assert.match(sourceRecipeSha256??'',/^[a-f0-9]{64}$/);
 return {version:'release-integrity-scope-20261112-v1',sourceRecipe:'integrity-dongying/input.json',sourceRecipeSha256,originalSiteIds:[...ORIGINAL_INTEGRITY_SITE_IDS],removedSiteIds:ORIGINAL_INTEGRITY_SITE_IDS.slice(0,3),effectiveSiteIds:[...INTEGRITY_SITE_IDS],decision:{path:'docs/product-decisions/2026-10-30-integrity-retired-sites.md',commit:'65297990a9733187319d7be0674d272c619b2334'},reason:'The user retired the three original sites for new queries. Preserve the original recipe and use five current financial-regulatory sites; keep csrc/sse and add pbc/nfra/szse.'};
}
const pairKeys=pairs=>pairs.map(p=>JSON.stringify([p.subject_id,p.site_id]));
export function assertIntegrityVisibleSettlement(round,entry,visible){
 const settlement=round.settlement,scope=round.manifest.scope_measurement;
 assert.equal(round.manifest.price_version,'bb-task-price-scope-20261111-v4');assert.equal(settlement?.version,'integrity-settlement-v1');assert.equal(settlement.outcome,'delivered');
 for(const field of ['quoted_points','charged_points','released_points'])assert.match(settlement[field],/^(0|[1-9][0-9]*)$/);
 assert.equal(settlement.quoted_points,entry.accepted?.points);assert.equal(settlement.charged_points,round.charged_points);assert.equal(BigInt(settlement.quoted_points),BigInt(settlement.charged_points)+BigInt(settlement.released_points));
 assert.equal(scope?.executable_pairs,5);assert.ok(Array.isArray(settlement.verified_query_pairs)&&settlement.verified_query_pairs.length>0);
 assert.ok(sameSet(pairKeys(settlement.verified_query_pairs),pairKeys(entry.integrityVerifiedPairs)),'Visible settlement differs from verified official captures');
 const amount=value=>BigInt(value).toLocaleString('zh-CN')+' 积分',completed=settlement.verified_query_pairs.length,remaining=scope.executable_pairs-completed;
 assert.equal(visible.amountsText,`原预留 ${amount(settlement.quoted_points)}，实际扣除 ${amount(settlement.charged_points)}，已释放 ${amount(settlement.released_points)}。`,'Visible accepted/charged/released points mismatch');
 assert.ok(visible.reasonText.includes(`本轮 ${scope.executable_pairs} 项可查询范围中，${completed} 项完成查询并保留官网证据；`),'Visible completed query count missing');
 assert.ok(visible.reasonText.includes(remaining?`其余 ${remaining} 项未完成有效查询，不计费。`:'已全部完成有效查询。'),'Visible partial-query billing explanation missing');
 assert.ok(visible.reasonText.includes('官网明确零结果也计为完成查询。'),'Visible zero-result meaning missing');
 assert.ok(sameSet(visible.items.map(i=>JSON.stringify([i.subjectId,i.siteId])),pairKeys(settlement.verified_query_pairs)),'Visible billed query identities mismatch');
 for(const item of visible.items){const subject=round.manifest.draft.subjects.find(s=>s.id===item.subjectId),record=round.records.find(r=>r.subject_id===item.subjectId&&r.site_id===item.siteId);assert.ok(subject?.name&&record?.site_name);assert.equal(item.text,subject.name+' · '+record.site_name,'Visible billed subject/site name mismatch');}
 return {version:'release-integrity-visible-settlement-v1',status:'passed',runId:entry.runId,priceVersion:round.manifest.price_version,quotedPoints:settlement.quoted_points,chargedPoints:settlement.charged_points,releasedPoints:settlement.released_points,executablePairs:scope.executable_pairs,verifiedPairs:structuredClone(settlement.verified_query_pairs)};
}

export function selectWorkpaperSubset(catalogue){
 assert.ok(catalogue?.catalogue_id&&Array.isArray(catalogue.entries),'Missing parsed catalogue');
 const selected=WORKPAPER_SUBSET.map(({code,row})=>{
  const matches=catalogue.entries.filter(e=>e.kind==='file'&&e.code===code);
  assert.equal(matches.length,1,'Missing or ambiguous fixed workpaper code '+code);const entry=matches[0];
  assert.equal(entry.row,row,'Fixed catalogue row changed for '+code);assert.equal(entry.sheet,'目录');
  assert.ok(entry.id&&entry.title?.trim()&&entry.path?.trim(),'Incomplete catalogue entry '+code);
  return {id:entry.id,code:entry.code,title:entry.title,path:entry.path,folder:entry.folder,row:entry.row,sheet:entry.sheet};
 });
 assert.equal(new Set(selected.map(e=>e.id)).size,5,'Parsed workpaper IDs are not unique');return selected;
}
export function subsetRequirements(recipe){
 assert.equal(typeof recipe?.requirements,'string');
 const original='仅处理底稿目录“1 尽职调查文件”。';assert.ok(recipe.requirements.startsWith(original),'Unexpected recipe scope');
 return '本次隔离验证仅处理已勾选的五项（'+WORKPAPER_SUBSET.map(e=>e.code).join('、')+'），属于固定功能验证子集，不代表原目录“1 尽职调查文件”全量。'+recipe.requirements.slice(original.length);
}
export function assertWorkpaperBatch(batch,entry,{complete=false}={}){
 id(entry.workpaperBatchId);id(entry.catalogueId);id(entry.source?.project_id);id(entry.source?.version_id);id(entry.source?.material_id);assert.match(entry.source.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(entry.source.selection_revision)&&entry.source.selection_revision>=0);assert.ok(Number.isSafeInteger(entry.source.material_version)&&entry.source.material_version>0);
 assert.equal(batch?.batch_id,entry.workpaperBatchId,'Wrong workpaper batch');
 assert.ok(Array.isArray(entry.selectedWorkpapers)&&entry.selectedWorkpapers.length===5,'Missing trusted selection');
 assert.ok(sameSet(entry.expectedItemIds,entry.selectedWorkpapers.map(e=>e.id)),'Locked item IDs changed');
 assert.ok(sameSet(batch.items?.map(i=>i.entry?.id),entry.selectedWorkpapers.map(e=>e.id)),'Batch differs from the five selected IDs');
 for(const item of batch.items){const chosen=entry.selectedWorkpapers.find(e=>e.id===item.entry.id);for(const key of ['code','title','path'])assert.equal(item.entry[key],chosen[key],'Batch changed selected '+key);}
 assert.equal(batch.source?.version_id,entry.source?.version_id);assert.equal(batch.source?.selection_revision,entry.source?.selection_revision);
 assert.equal(batch.source?.asset?.pin?.sha256,entry.source?.sha256,'Batch source hash differs');
 assert.equal(batch.source?.project_id,entry.source?.project_id);assert.equal(batch.source?.asset?.pin?.material_id,entry.source?.material_id);assert.equal(batch.source?.asset?.pin?.material_version,entry.source?.material_version);
 assert.equal(batch.source?.asset?.kind,'material');assert.equal(batch.source?.asset?.pin?.source_project_id,entry.source.project_id);
 assert.equal(batch.catalogue_id,entry.catalogueId,'Batch catalogue changed');
 if(complete){assert.equal(batch.state,'complete','Workpaper batch is not complete');for(const item of batch.items)assert.equal(item.state,'succeeded','A selected workpaper is unfinished');}
 return batch;
}
export function assertCatalogueUpload(request,material,expected){
 const pin=request?.material;assert.equal(request?.scope,'due_diligence');assert.ok(pin?.source_project_id);
 assert.equal(pin.sha256,expected.sha256,'Imported workbook bytes changed');
 assert.equal(material?.material_id,pin.material_id);assert.equal(material.material_version,pin.material_version);assert.equal(material.sha256,expected.sha256);
 assert.equal(material.filename,expected.filename);assert.equal(material.byte_size,expected.byte_size);assert.ok(material.persisted_at);
 return {...pin,filename:material.filename,byte_size:material.byte_size};
}
export function recoverWorkpaperReceipt(entry){
 const receipt=entry.fileGenerationReceipt??entry.submissionReceipt?.body;
 if(!receipt)return;
 if(entry.batchId)assert.equal(entry.batchId,receipt.batch_id,'Top-level batch changed');
 if(entry.packageBatchId)assert.equal(entry.packageBatchId,receipt.batch_id,'Package batch changed');
 if(entry.workpaperBatchId)assert.equal(entry.workpaperBatchId,receipt.workpapers?.batch_id,'Workpaper batch changed');
 entry.batchId=id(receipt.batch_id);entry.workpaperBatchId=id(receipt.workpapers?.batch_id);entry.fileGenerationReceipt=receipt;
}
export function sourceBinding(source,material,expected){
 const pin=source?.asset?.pin;
 assert.equal(source?.asset?.kind,'material');assert.ok(source.project_id&&source.version_id);assert.ok(Number.isSafeInteger(source.selection_revision)&&source.selection_revision>=0);
 assert.equal(pin?.source_project_id,source.project_id);assert.equal(source.filename,expected.filename);assert.equal(pin.sha256,expected.sha256);
 assert.equal(material?.material_id,pin.material_id);assert.equal(material.material_version,pin.material_version);assert.equal(material.sha256,expected.sha256);assert.equal(material.filename,expected.filename);assert.equal(material.byte_size,expected.byte_size);assert.ok(material.persisted_at);
 return {project_id:source.project_id,version_id:source.version_id,selection_revision:source.selection_revision,sequence:source.sequence,material_id:pin.material_id,material_version:pin.material_version,...expected};
}
export function selectedProspectusBinding(versions,material,expected,projectId){
 assert.equal(versions?.project_id,id(projectId),'Prospectus belongs to another project');
 assert.ok(Number.isSafeInteger(versions.selection_revision)&&versions.selection_revision>0,'Missing saved prospectus selection');
 const selected=versions.versions.filter(v=>v.version_id===id(versions.current_version_id));assert.equal(selected.length,1,'Selected prospectus is missing or ambiguous');
 const version=selected[0];assert.equal(version.origin,'upload');assert.equal(version.artifact_id,null);assert.equal(version.artifact_version,null);
 assert.ok(Number.isSafeInteger(version.sequence)&&version.sequence>0);id(version.material_id);assert.ok(Number.isSafeInteger(version.material_version)&&version.material_version>0);
 assert.equal(version.filename,expected.filename);assert.equal(version.sha256,expected.sha256);
 assert.equal(material?.material_id,version.material_id);assert.equal(material.material_version,version.material_version);assert.equal(material.sha256,expected.sha256);assert.equal(material.filename,expected.filename);assert.equal(material.byte_size,expected.byte_size);assert.ok(material.persisted_at);
 return {project_id:projectId,version_id:version.version_id,selection_revision:versions.selection_revision,sequence:version.sequence,material_id:version.material_id,material_version:version.material_version,...expected};
}
/** Ordinary project files do not create an M4 workspace. Read their selected
 * prospectus directly; generation still requires its real workspace source. */
export async function adoptProspectusSource({page,fixture,readJson,save,upload},entry,generation){
 const expected=sourceFixture(fixture),base=projectBase(entry);
 async function until(read,valid,message,timeoutMs=120000){const end=Date.now()+timeoutMs;do{const value=await read();if(valid(value))return value;await page.waitForTimeout(500);}while(Date.now()<end);throw Error(message);}
 const workspace=generation?await readJson(base+'/project-files/workspace'):null,sourceProject=workspace?.source?.project_id??entry.projectId;
 const versionURL='/api/v1/projects/'+encodeURIComponent(id(sourceProject))+'/prospectus-versions';
 const readVersions=async()=>{const v=await readJson(versionURL);assert.equal(v?.project_id,sourceProject,'Prospectus belongs to another project');assert.ok(Array.isArray(v.versions));return v;};
 let versions=await readVersions(),matches=versions.versions.filter(v=>v.sha256===expected.sha256&&v.filename===expected.filename);
 assert.ok(matches.length<=1,'Multiple source versions match the original fixture');
 if(!matches.length){
  if(entry.sourceUploadStarted)throw Error('Original prospectus upload is unresolved; refusing another upload');
  entry.sourceUploadStarted={...expected};save();await upload(page.getByLabel('募集书新版本文件',{exact:true}),fixture);
  versions=await until(readVersions,v=>v.versions.some(x=>x.sha256===expected.sha256&&x.filename===expected.filename),'Original prospectus was not persisted',600000);
  matches=versions.versions.filter(v=>v.sha256===expected.sha256&&v.filename===expected.filename);assert.equal(matches.length,1);
 }
 const version=matches[0];versions=await readVersions();
 if(versions.current_version_id!==version.version_id){
  if(generation){await page.locator('input[name="generation-source-mode"][value="project"]').check();await page.locator('#pf-project-source').selectOption(version.version_id);}
  else{const history=page.locator('[data-prospectus-history]');if(await history.getAttribute('open')===null)await history.locator('summary').click();await page.locator(field('data-use-version',version.version_id)).click();await page.locator('#confirm-prospectus-selection').click();}
  await until(readVersions,v=>v.current_version_id===version.version_id,'Original prospectus was not adopted');
 }
 async function readBinding(){
  if(generation){
   const w=await until(()=>readJson(base+'/project-files/workspace'),v=>v.source?.version_id===version.version_id,'Adopted source is not available in the workspace');
   const pin=w.source.asset.pin,material=await readJson('/api/v1/projects/'+encodeURIComponent(pin.source_project_id)+'/materials/'+encodeURIComponent(pin.material_id)+'?version='+pin.material_version);
   return sourceBinding(w.source,material,expected);
  }
  const v=await readVersions();assert.equal(v.current_version_id,version.version_id,'Adopted prospectus changed');
  const selected=v.versions.filter(value=>value.version_id===v.current_version_id);assert.equal(selected.length,1,'Selected prospectus is missing or ambiguous');
  const pin=selected[0];id(pin.material_id);assert.ok(Number.isSafeInteger(pin.material_version)&&pin.material_version>0);
  const material=await readJson(base+'/materials/'+encodeURIComponent(pin.material_id)+'?version='+pin.material_version);
  return selectedProspectusBinding(v,material,expected,entry.projectId);
 }
 const binding=await readBinding();if(entry.source)assert.deepEqual(binding,entry.source,'Adopted original source changed');entry.source=binding;save();
 await page.reload();assert.deepEqual(await readBinding(),binding,'Reload changed the adopted original source');
 await page.getByText(expected.filename,{exact:false}).first().waitFor({state:'visible'});
}
export function assertIntegrityRound(round,entry){
 assert.equal(round?.run_id,entry.runId);assert.equal(round.operation,'check');assert.equal(round.state,'succeeded');
 const draft=round.manifest?.draft;assert.equal(draft?.subjects?.length,1);const subject=draft.subjects[0];
 assert.equal(subject.kind,'company');assert.equal(subject.name,entry.issuerName);assert.equal(subject.role,'发行人');
 assert.ok(sameSet(draft.site_ids,INTEGRITY_SITE_IDS),'Locked integrity websites changed');
 assert.equal(round.records?.length,5,'Missing integrity site records');
 assert.ok(sameSet(round.records.map(r=>r.site_id),INTEGRITY_SITE_IDS));
 for(const record of round.records){assert.equal(record.subject_id,subject.id);assert.ok(record.status&&record.checked_at);}
 return subject;
}
export function verifiedCaptureCandidates(round,issuerName){
 const hosts={pbc:'pbc.gov.cn',nfra:'nfra.gov.cn',csrc:'csrc.gov.cn',sse:'sse.com.cn',szse:'szse.cn'};
 return round.records.flatMap(record=>{
  if(record.search_performed!==true||!record.query?.includes(issuerName)||!['results','no_results'].includes(record.browser?.outcome)||!['public_matches','no_public_results'].includes(record.status))return [];
  return (record.browser.captures??[]).filter(c=>{try{const u=new URL(c.url),host=u.hostname,official=hosts[record.site_id];return typeof c.id==='string'&&c.id&&c.kind==='result'&&['http:','https:'].includes(u.protocol)&&official&&(host===official||host.endsWith('.'+official))&&/^[a-f0-9]{64}$/.test(c.screenshot_sha256);}catch{return false;}}).map(capture=>({record,capture}));
 });
}

/** Only this module owns the two added UI journeys. The driver owns execution
 * budgets, request receipts, credentials, artifacts and billing reconciliation.
 */
export function extendedFlows(ctx){
 const {page,fixtures:f,report,save,upload,submit,readJson,waitRun,download,mapWorkpapers}=ctx;
 async function until(read,valid,message,timeoutMs=120000){const end=Date.now()+timeoutMs;do{const value=await read();if(valid(value))return value;await page.waitForTimeout(500);}while(Date.now()<end);throw Error(message);}
 async function createProject(entry,kind){
  if(entry.projectURL){id(entry.projectId);await page.goto(entry.projectURL);return;}
  if(entry.projectId){entry.projectURL=new URL('/#'+kind+'?project='+encodeURIComponent(id(entry.projectId)),page.url()).href;save();await page.goto(entry.projectURL);return;}
  if(entry.projectCreationAttempted)throw Error('Project creation receipt is unknown; refusing another project');
  await page.goto('/#'+kind);await page.locator('#project-entry-new').click();const modal=page.locator('dialog[open]');
  await modal.getByLabel('项目名称',{exact:true}).fill('发布前测试-东营'+(kind==='integrity'?'诚信':'底稿'));
  await modal.getByLabel('发行人全称',{exact:true}).fill(entry.issuerName);await modal.locator('select[name="market"]').selectOption('sse');await modal.locator('select[name="offering"]').selectOption('private');
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/projects');response.catch(()=>{});
  entry.projectCreationAttempted=true;save();await modal.getByRole('button',{name:kind==='integrity'?'创建项目并准备核查':'创建项目，选择募集说明书',exact:true}).click();
  const result=await response;assert.ok(result.ok(),'Project creation failed');entry.projectId=id((await result.json()).project_id);save();
  await page.waitForURL(u=>new URLSearchParams(u.hash.split('?')[1]).get('project')===entry.projectId);entry.projectURL=page.url();save();
 }
  const adoptSource=(entry,generation)=>adoptProspectusSource({page,fixture:f.dongying,readJson,save,upload},entry,generation);
 const integrity=async(entry,phase)=>{
   const recipe=f.integrityRecipe,revision=integrityScopeRevision(recipe,report?.fixtureHashes?.find(f=>f.id==='integrity-dongying/input.json')?.sha256);
   if(entry.integrityScopeRevision)assert.deepEqual(entry.integrityScopeRevision,revision,'Accepted integrity test scope changed');
   else{assert.ok(!entry.prepared&&!entry.runId,'Existing integrity task has no original scope revision; preserve it without resubmission');entry.integrityScopeRevision=revision;entry.originalIntegrityRecipe=structuredClone(recipe);save();}
   assert.deepEqual(entry.originalIntegrityRecipe,recipe,'Original integrity recipe changed on resume');entry.issuerName=recipe.issuer_name;
  if(!entry.runId){
   await createProject(entry,'integrity');
   if(!entry.prepared){
    await page.getByRole('link',{name:'项目文件 →',exact:true}).click();await adoptSource(entry,false);entry.sourceUsage='Original prospectus uploaded and adopted for the project; the integrity draft has no material_versions input.';save();await page.goto(entry.projectURL);
    await page.locator('#integrity-issuer').click();assert.equal(await page.locator('[data-subject-row]').count(),1,'Expected one issuer subject');const row=page.locator('[data-subject-row]');
    await row.locator('[data-field="kind"]').selectOption('company');await row.locator('[data-field="name"]').fill(recipe.issuer_name);await row.locator('[data-field="role"]').fill('发行人');await row.locator('[data-field="identifier"]').fill('');
    await page.locator('[data-region][data-field="province"]').selectOption('');await page.locator('[data-region][data-field="city"]').fill('');
    await page.locator('#integrity-none').click();for(const site of INTEGRITY_SITE_IDS)await page.locator('input[name="integrity-site"]'+field('value',site)).check();await page.locator('#integrity-notes').fill(recipe.draft.notes);
    const saved=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===projectBase(entry)+'/integrity/draft');saved.catch(()=>{});await page.locator('#integrity-save').click();assert.ok((await saved).ok(),'Integrity draft save failed');
    const state=await readJson(projectBase(entry)+'/integrity');assert.equal(state.draft.subjects.length,1);assert.equal(state.draft.subjects[0].name,recipe.issuer_name);assert.ok(sameSet(state.draft.site_ids,INTEGRITY_SITE_IDS));assert.equal(state.draft.notes,recipe.draft.notes);
    entry.integrityDraft=state.draft;entry.integrityRevision=state.revision;entry.prepared=true;save();await page.reload();const restored=await readJson(projectBase(entry)+'/integrity');assert.deepEqual(restored.draft,entry.integrityDraft);
   }
   const receipt=await submit(page.locator('#integrity-start'),/\/integrity\/runs$/,entry);entry.runId=id(receipt.run_id);save();
   const state=await readJson(projectBase(entry)+'/integrity?run_id='+encodeURIComponent(entry.runId));const round=state.rounds.find(r=>r.run_id===entry.runId);assert.ok(round,'Accepted integrity round missing');entry.integrityRound=round;entry.roundId=round.round_id;entry.acceptedPriceVersion=round.manifest.price_version;save();
  }
  if(phase==='submit')return;
  await waitRun(entry.runId,entry);const state=await readJson(projectBase(entry)+'/integrity?run_id='+encodeURIComponent(entry.runId)),round=state.rounds.find(r=>r.run_id===entry.runId),subject=assertIntegrityRound(round,entry);
  entry.integrityRound=round;entry.queryEvidence=[];entry.integrityVerifiedPairs=[];save();await page.goto(withQuery(entry.projectURL,{run:entry.runId}));const section=page.locator(field('data-integrity-subject',subject.id));await section.waitFor({state:'visible'});if(await section.getAttribute('open')===null)await section.locator('summary').click();
  for(const site of INTEGRITY_SITE_IDS)await section.locator(field('data-evidence','0:'+site)).waitFor({state:'visible'});
  const candidates=verifiedCaptureCandidates(round,entry.issuerName);assert.ok(candidates.length,'All five official queries are blocked, failed or unverified');
  for(const {record,capture} of candidates){
   const response=await page.request.get(projectBase(entry)+'/integrity/runs/'+encodeURIComponent(entry.runId)+'/captures/'+encodeURIComponent(capture.id));assert.ok(response.ok(),'Saved official capture is unavailable');const bytes=await response.body();assert.equal(sha256(bytes),capture.screenshot_sha256);assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Capture is not PNG');
   entry.queryEvidence.push({siteId:record.site_id,captureId:capture.id,outcome:record.browser.outcome,query:record.query,url:capture.url,sha256:capture.screenshot_sha256,bytes:bytes.length});if(!entry.integrityVerifiedPairs.some(p=>p.subject_id===record.subject_id&&p.site_id===record.site_id))entry.integrityVerifiedPairs.push({subject_id:record.subject_id,site_id:record.site_id});save();
  }
  const first=candidates[0];await section.locator(field('data-evidence','0:'+first.record.site_id)).click();const modal=page.locator('dialog[open]');const index=first.record.browser.captures.findIndex(c=>c.id===first.capture.id);await modal.locator(field('data-auto-capture',index)).click();await modal.locator(field('data-auto-preview',index)+' img').waitFor({state:'visible'});await modal.getByRole('button',{name:'关闭',exact:true}).click();
   const billing=page.locator('[data-integrity-settlement]');await billing.waitFor({state:'visible'});const billedScope=billing.locator('[data-integrity-settlement-scope]');if(await billedScope.getAttribute('open')===null)await billedScope.locator('summary').click();
   const visible={observedAt:new Date().toISOString(),amountsText:await billing.locator('[data-integrity-settlement-amounts]').innerText(),reasonText:await billing.locator('[data-integrity-settlement-reason]').innerText(),items:await billedScope.locator('[data-integrity-billed-site]').evaluateAll(nodes=>nodes.map(node=>({subjectId:node.getAttribute('data-integrity-billed-subject'),siteId:node.getAttribute('data-integrity-billed-site'),text:node.innerText})))};
   const explained=assertIntegrityVisibleSettlement(round,entry,visible),previous=entry.integrityBillingPageEvidence;if(previous){const {observations,...identity}=previous;assert.deepEqual(identity,explained,'Refresh changed visible integrity settlement');}
   entry.integrityBillingPageEvidence={...explained,observations:[...(previous?.observations??[]),visible]};save();
  const company=round.artifacts.filter(a=>a.kind==='company');assert.equal(company.length,1,'Expected one company report');const button=page.locator(field('data-integrity-download',company[0].artifact_id));await download(button,'integrity.docx',entry);
 };
 const workpaper=async(entry,phase)=>{
  const recipe=f.workpaperRecipe;assert.equal(recipe?.case_id,'workpaper-dongying');entry.issuerName=recipe.issuer_name;
  recoverWorkpaperReceipt(entry);
  if(!entry.batchId&&!entry.workpaperBatchId){
   await createProject(entry,'generate');
   if(!entry.prepared){
    await page.goto(withQuery(entry.projectURL,{step:'source'}));await adoptSource(entry,true);await page.locator('#pf-source-next').click();await page.locator('#fg-confirm').waitFor({state:'visible'});
    for(const input of await page.locator('[data-fg-type]').all()){if(await input.getAttribute('data-fg-type')==='workpaper')await input.check();else await input.uncheck();}
    const expected=sourceFixture(f.workpaperCatalogue);const generation=await readJson(projectBase(entry)+'/file-generation');let catalogue=generation.preparation.catalogue_id?await readJson(projectBase(entry)+'/workpapers/catalogues/'+encodeURIComponent(generation.preparation.catalogue_id)):null;
    if(!entry.catalogueReceipt){
     assert.equal(catalogue,null,'Fresh isolated project has an unexpected catalogue');
     if(entry.catalogueUploadStarted)throw Error('Original catalogue import is unresolved; refusing another upload');entry.catalogueUploadStarted=expected;save();
     const preview=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===projectBase(entry)+'/workpapers/catalogue-preview',{timeout:180000});preview.catch(()=>{});await upload(page.locator('#fg-catalogue-upload'),f.workpaperCatalogue);const previewResponse=await preview;assert.ok(previewResponse.ok(),'Catalogue preview failed');entry.cataloguePreview=await previewResponse.json();entry.cataloguePreviewRequest=previewResponse.request().postDataJSON();save();
     const workbookPin=entry.cataloguePreviewRequest.material,workbookMaterial=await readJson('/api/v1/projects/'+encodeURIComponent(id(workbookPin.source_project_id))+'/materials/'+encodeURIComponent(id(workbookPin.material_id))+'?version='+workbookPin.material_version);entry.catalogueUpload=assertCatalogueUpload(entry.cataloguePreviewRequest,workbookMaterial,expected);save();
     await page.locator('#fg-import-review').waitFor({state:'visible'});assert.equal(await page.locator('#wp-all-sheets').isChecked(),false,'Do not silently expand the catalogue scope');
     const imported=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===projectBase(entry)+'/workpapers/catalogues',{timeout:180000});imported.catch(()=>{});await page.locator('#wp-accept-mapping').click();const importedResponse=await imported;assert.ok(importedResponse.ok(),'Catalogue import failed');catalogue=await importedResponse.json();entry.catalogueReceipt=catalogue;entry.catalogueImportRequest=importedResponse.request().postDataJSON();save();
     assert.deepEqual(entry.catalogueImportRequest.material,entry.cataloguePreviewRequest.material);assert.equal(entry.catalogueImportRequest.scope,'due_diligence');
    }
    catalogue=await readJson(projectBase(entry)+'/workpapers/catalogues/'+encodeURIComponent(id(entry.catalogueReceipt.catalogue_id)));assert.deepEqual(catalogue,entry.catalogueReceipt,'Persisted parsed catalogue changed');assert.match(catalogue.sha256,/^[a-f0-9]{64}$/);assert.equal(catalogue.filename,expected.filename);assert.equal(entry.catalogueUpload?.sha256,expected.sha256);assert.deepEqual(entry.catalogueImportRequest.material,entry.cataloguePreviewRequest.material);assert.equal(entry.catalogueImportRequest.scope,'due_diligence');
    entry.selectedWorkpapers=selectWorkpaperSubset(catalogue);entry.expectedItemIds=entry.selectedWorkpapers.map(e=>e.id);entry.catalogueId=catalogue.catalogue_id;entry.recipeRequirements=recipe.requirements;entry.requirements=subsetRequirements(recipe);save();
    await page.locator('#fg-edit-scope').click();await page.locator('#fg-select-none').click();for(const selected of entry.selectedWorkpapers){await page.locator('#fg-filter').fill(selected.code);await page.locator('#fg-filter').press('Tab');await page.locator(field('data-fg-item',selected.id)).check();}
    await page.locator('#fg-filter').fill('');await page.locator('#fg-filter').press('Tab');assert.equal(await page.locator('#fg-automatic').getAttribute('aria-pressed'),'true');
    const supporting=page.locator('#fg-supporting-details');if(await supporting.getAttribute('open')===null)await supporting.locator('summary').click();await page.locator('#fg-requirements').fill(entry.requirements);await page.locator('#fg-save').click();
    const saved=await until(()=>readJson(projectBase(entry)+'/file-generation'),w=>w.preparation.catalogue_id===entry.catalogueId&&sameSet(w.preparation.item_ids,entry.selectedWorkpapers.map(e=>e.id))&&w.preparation.requirements===entry.requirements,'Five-item preparation did not persist');assert.equal(saved.preparation.workpaper_template_mode,'automatic');assert.deepEqual(saved.preparation.document_types,['workpaper']);
    entry.preparation=saved.preparation;entry.preparationRevision=saved.revision;entry.prepared=true;save();await page.reload();const restored=await readJson(projectBase(entry)+'/file-generation');assert.deepEqual(restored.preparation,entry.preparation);assert.equal(restored.revision,entry.preparationRevision);
   }else await page.goto(withQuery(entry.projectURL,{step:'prepare'}));
   const receipt=await submit(page.locator('#fg-confirm'),/\/file-generation\/batches$/,entry);entry.batchId=receipt.batch_id;entry.workpaperBatchId=receipt.workpapers?.batch_id;entry.fileGenerationReceipt=receipt;save();id(entry.batchId);id(entry.workpaperBatchId);assertWorkpaperBatch(receipt.workpapers,entry);entry.topicId=receipt.workpapers.topic_id;save();
  }
  id(entry.batchId);id(entry.workpaperBatchId);if(phase==='submit')return;
  const batch=assertWorkpaperBatch(await readJson(projectBase(entry)+'/workpapers/batches/'+encodeURIComponent(entry.workpaperBatchId)),entry,{complete:true});entry.workpaperBatch=batch;entry.batchState=batch.state;
  const expectedWorkpapers=await mapWorkpapers(batch);if(entry.expectedWorkpapers)assert.deepEqual(expectedWorkpapers,entry.expectedWorkpapers,'Delivered workpaper mapping changed');entry.expectedWorkpapers=expectedWorkpapers;save();
  const url=withQuery(entry.projectURL,{step:'workpapers',view:'results',batch:entry.workpaperBatchId});await page.goto(url);const panel=page.locator(field('data-wp-batch-id',entry.workpaperBatchId));await panel.locator('.wp-batch-state[data-state="complete"]').waitFor({state:'visible'});assert.equal((await panel.locator('.wp-batch-count strong').innerText()).trim(),'5');
  await download(panel.locator(field('data-wp-zip',entry.workpaperBatchId)),'workpaper.zip',entry);
 };
 workpaper.readState=async entry=>{const batch=assertWorkpaperBatch(await readJson(projectBase(entry)+'/workpapers/batches/'+encodeURIComponent(id(entry.workpaperBatchId))),entry);entry.workpaperBatch=batch;entry.itemRunIds=[...new Set(batch.items.map(i=>i.run_id).filter(Boolean))];entry.batchState=batch.state;entry.stage=batch.items.find(i=>['queued','running','preparing','validating','delivering'].includes(i.state))?.stage??null;save();return {state:batch.state,stage:entry.stage};};
 return {'integrity-dongying':integrity,'workpaper-dongying':workpaper};
}
