import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ORIGINAL_INTEGRITY_SITE_IDS,INTEGRITY_SITE_IDS,integrityScopeRevision,assertIntegrityVisibleSettlement,WORKPAPER_SUBSET,selectWorkpaperSubset,subsetRequirements,assertWorkpaperBatch,assertCatalogueUpload,recoverWorkpaperReceipt,sourceBinding,selectedProspectusBinding,adoptProspectusSource,assertIntegrityRound,verifiedCaptureCandidates,extendedFlows} from './flows-extended.mjs';

const issuer='东营市城市建设发展集团有限公司',hash='a'.repeat(64),otherHash='b'.repeat(64);
const recipe=JSON.parse(readFileSync(new URL('../../tests/samples/2026-11-05/cases/workpaper-dongying/input.json',import.meta.url)));
const catalogue=()=>({catalogue_id:'catalogue',sha256:otherHash,filename:'原目录.xlsx',entries:WORKPAPER_SUBSET.map(({code,row},i)=>({id:'selected-'+i,code,row,sheet:'目录',kind:'file',title:'事项 '+i,path:code+' 事项 '+i+'.docx',folder:'目录'}))});
const expected={filename:'原募集说明书.docx',byte_size:12345,sha256:hash};
const source=()=>({project_id:'source-project',version_id:'prospectus',selection_revision:3,sequence:1,filename:expected.filename,asset:{kind:'material',pin:{source_project_id:'source-project',material_id:'material',material_version:2,sha256:hash}}});
const material=()=>({material_id:'material',material_version:2,...expected,persisted_at:'2026-11-12T01:00:00Z'});
function saved(){const selectedWorkpapers=selectWorkpaperSubset(catalogue());return {id:'workpaper-dongying',projectId:'navigation-project',projectURL:'http://localhost:5288/#generate?project=navigation-project',batchId:'package-batch',workpaperBatchId:'workpaper-batch',catalogueId:'catalogue',source:sourceBinding(source(),material(),expected),selectedWorkpapers,expectedItemIds:selectedWorkpapers.map(e=>e.id)};}
const batch=entry=>({batch_id:entry.workpaperBatchId,catalogue_id:entry.catalogueId,state:'complete',source:source(),items:entry.selectedWorkpapers.map((e,i)=>({entry:{...e},state:'succeeded',run_id:'item-run-'+i,stage:null}))});
const integrityRecipe={case_id:'integrity-dongying',issuer_name:issuer,draft:{site_ids:[...ORIGINAL_INTEGRITY_SITE_IDS]}};
const report={fixtureHashes:[{id:'integrity-dongying/input.json',sha256:hash}]};
const integrityEntry=()=>({runId:'integrity-run',projectId:'navigation-project',projectURL:'http://localhost:5288/#integrity?project=navigation-project',integrityScopeRevision:integrityScopeRevision(integrityRecipe,hash),originalIntegrityRecipe:structuredClone(integrityRecipe),accepted:{points:'2425'},integrityVerifiedPairs:INTEGRITY_SITE_IDS.map(site_id=>({subject_id:'issuer',site_id}))});
function round(){const subject={id:'issuer',name:issuer,kind:'company',role:'发行人'},urls={pbc:'https://www.pbc.gov.cn/',nfra:'https://www.nfra.gov.cn/',csrc:'https://neris.csrc.gov.cn/shixinchaxun/',sse:'https://www.sse.com.cn/search/',szse:'https://www.szse.cn/'};return {run_id:'integrity-run',operation:'check',state:'succeeded',charged_points:'2425',settlement:{version:'integrity-settlement-v1',outcome:'delivered',quoted_points:'2425',charged_points:'2425',released_points:'0',verified_query_pairs:INTEGRITY_SITE_IDS.map(site_id=>({subject_id:subject.id,site_id}))},manifest:{price_version:'bb-task-price-scope-20261111-v4',scope_measurement:{executable_pairs:5},draft:{subjects:[subject],site_ids:[...INTEGRITY_SITE_IDS]}},records:INTEGRITY_SITE_IDS.map(site_id=>({subject_id:subject.id,site_id,site_name:'官网 '+site_id,status:'no_public_results',checked_at:'2026-11-12T01:00:00Z',query:issuer,search_performed:true,browser:{outcome:'no_results',captures:[{id:site_id,kind:'result',url:urls[site_id],screenshot_sha256:hash}]}}))};}
function visibleSettlement(r){const s=r.settlement,n=s.verified_query_pairs.length,amount=v=>BigInt(v).toLocaleString('zh-CN')+' 积分';return {amountsText:`原预留 ${amount(s.quoted_points)}，实际扣除 ${amount(s.charged_points)}，已释放 ${amount(s.released_points)}。`,reasonText:`本轮 5 项可查询范围中，${n} 项完成查询并保留官网证据；${n===5?'已全部完成有效查询。':`其余 ${5-n} 项未完成有效查询，不计费。`}官网明确零结果也计为完成查询。`,items:s.verified_query_pairs.map(p=>({subjectId:p.subject_id,siteId:p.site_id,text:issuer+' · 官网 '+p.site_id}))};}

test('explicit versioned current-site override preserves exact original recipe/hash and five sites',()=>{
 const original=structuredClone(integrityRecipe),revision=integrityScopeRevision(integrityRecipe,hash);assert.deepEqual(integrityRecipe,original);assert.deepEqual(revision.originalSiteIds,ORIGINAL_INTEGRITY_SITE_IDS);assert.deepEqual(revision.effectiveSiteIds,['pbc','nfra','csrc','sse','szse']);assert.deepEqual(revision.removedSiteIds,ORIGINAL_INTEGRITY_SITE_IDS.slice(0,3));assert.equal(revision.sourceRecipeSha256,hash);assert.equal(revision.decision.path,'docs/product-decisions/2026-10-30-integrity-retired-sites.md');
 assert.throws(()=>integrityScopeRevision({...original,draft:{site_ids:INTEGRITY_SITE_IDS}},hash));assert.throws(()=>integrityScopeRevision(original,'wrong'));
});
test('visible fee evidence requires exact actual amounts, completed scope, reason and named billed pairs',()=>{
 const r=round(),entry=integrityEntry();assert.equal(assertIntegrityVisibleSettlement(r,entry,visibleSettlement(r)).status,'passed');
 r.settlement.verified_query_pairs=r.settlement.verified_query_pairs.slice(0,2);r.settlement.charged_points=r.charged_points='2170';r.settlement.released_points='255';entry.integrityVerifiedPairs=r.settlement.verified_query_pairs;assert.equal(assertIntegrityVisibleSettlement(r,entry,visibleSettlement(r)).releasedPoints,'255');
 for(const mutate of [v=>v.amountsText=v.amountsText.replace('255','0'),v=>v.reasonText='',v=>v.reasonText=v.reasonText.replace('不计费','仍计费'),v=>v.items.pop(),v=>v.items[0].text='其它项目',v=>v.items[0].siteId='other']){const visible=visibleSettlement(r);mutate(visible);assert.throws(()=>assertIntegrityVisibleSettlement(r,entry,visible));}
 const visible=visibleSettlement(r);assert.throws(()=>assertIntegrityVisibleSettlement({...r,settlement:null},entry,visible));assert.throws(()=>assertIntegrityVisibleSettlement(r,{...entry,integrityVerifiedPairs:[]},visible));
});

test('selects only the five exact f009 codes with original rows, names and paths',()=>{
 const cat=catalogue();cat.entries.reverse();cat.entries.push({...cat.entries[0],id:'unrelated',code:'9-9',row:300});
 const selected=selectWorkpaperSubset(cat);assert.deepEqual(selected.map(e=>e.code),WORKPAPER_SUBSET.map(e=>e.code));assert.deepEqual(selected.map(e=>e.row),[97,117,132,79,76]);assert.equal(selected[0].path,'2-1-4 事项 0.docx');assert.equal(cat.entries.length,6);
});
test('rejects missing, duplicate, wrong-row, wrong-sheet and incomplete workpaper identities',()=>{
 for(const mutate of [c=>c.entries.pop(),c=>c.entries.push({...c.entries[0],id:'duplicate'}),c=>c.entries[0].row++,c=>c.entries[0].sheet='替代工作表',c=>c.entries[0].path='',c=>c.entries[0].title=' ',c=>c.entries[0].kind='folder',c=>c.entries[1].id=c.entries[0].id]){const c=catalogue();mutate(c);assert.throws(()=>selectWorkpaperSubset(c));}
});
test('changes only the approved five-item subset prefix and preserves the actual recipe file',()=>{
 const original=recipe.requirements,result=subsetRequirements(recipe);assert.ok(result.startsWith('本次隔离验证仅处理已勾选的五项（2-1-4、2-3-6、2-4-2、1-5-7-1、1-5-5）'));assert.ok(result.endsWith(original.slice('仅处理底稿目录“1 尽职调查文件”。'.length)));assert.equal(recipe.requirements,original);assert.throws(()=>subsetRequirements({requirements:'其它范围'}));
});
test('binds original bytes to the real source project, material and selection revision',()=>{
 const actual=sourceBinding(source(),material(),expected);assert.equal(actual.project_id,'source-project');assert.equal(actual.material_version,2);assert.equal(actual.selection_revision,3);
 for(const mutate of [s=>s.asset.pin.sha256=otherHash,s=>s.asset.pin.source_project_id='other',s=>s.selection_revision=-1,s=>s.filename='旧稿.docx',s=>s.asset.kind='artifact']){const s=source();mutate(s);assert.throws(()=>sourceBinding(s,material(),expected));}
 for(const mutate of [m=>m.sha256=otherHash,m=>m.material_version=1,m=>m.byte_size--,m=>m.persisted_at=null]){const m=material();mutate(m);assert.throws(()=>sourceBinding(source(),m,expected));}
});
const prospectuses=()=>({project_id:'source-project',current_version_id:'prospectus',selection_revision:3,versions:[{version_id:'prospectus',sequence:1,origin:'upload',filename:expected.filename,sha256:hash,material_id:'material',material_version:2,artifact_id:null,artifact_version:null}]});
test('ordinary selected prospectus binds the real DTO without manufacturing a workspace',()=>{
 assert.deepEqual(selectedProspectusBinding(prospectuses(),material(),expected,'source-project'),sourceBinding(source(),material(),expected));
 for(const mutate of [v=>v.project_id='other',v=>v.current_version_id=null,v=>v.current_version_id='other',v=>v.selection_revision=0,v=>v.selection_revision=1.5,v=>v.versions=[],v=>v.versions.push({...v.versions[0]}),v=>v.versions[0].origin='generated',v=>v.versions[0].artifact_id='artifact',v=>v.versions[0].artifact_version=1,v=>v.versions[0].material_id='other',v=>v.versions[0].material_version++,v=>v.versions[0].sequence=0,v=>v.versions[0].sha256=otherHash,v=>v.versions[0].filename='other.docx']){const v=prospectuses();mutate(v);assert.throws(()=>selectedProspectusBinding(v,material(),expected,'source-project'));}
 for(const mutate of [m=>m.material_id='other',m=>m.material_version++,m=>m.sha256=otherHash,m=>m.filename='other.docx',m=>m.byte_size--,m=>m.persisted_at=null]){const m=material();mutate(m);assert.throws(()=>selectedProspectusBinding(prospectuses(),m,expected,'source-project'));}
});
function sourcePage(t,{generation=false,existing=false,autoAdopt=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'bb-source-adoption-')),fixture=join(directory,expected.filename),bytes=Buffer.from('synthetic source bytes; no model, browser or product API');writeFileSync(fixture,bytes);t.after(()=>{unlinkSync(fixture);rmdirSync(directory);});
 const actual={filename:expected.filename,byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const projectId='navigation-project',sourceProject=generation?'source-project':projectId,entry={projectId,projectURL:'http://localhost:5288/#integrity?project='+projectId,projectCreationAttempted:true};
 const version={...prospectuses().versions[0],...actual},versions={...prospectuses(),project_id:sourceProject,current_version_id:existing?version.version_id:null,selection_revision:existing?3:0,versions:existing?[version]:[]};
 const state={versions,material:{...material(),...actual},uploads:0,saves:0,reloads:0,calls:[],actions:[],onReload:()=>{},readError:null};
 const adopt=()=>{versions.current_version_id=version.version_id;versions.selection_revision++;};
 const locator=selector=>({locator:child=>locator(child),async getAttribute(){return null;},async click(){state.actions.push(selector);if(selector==='#confirm-prospectus-selection')adopt();else assert.ok(selector==='summary'||selector.startsWith('[data-use-version='));},async check(){assert.ok(generation);state.actions.push(selector);},async selectOption(value){assert.ok(generation);assert.equal(value,version.version_id);state.actions.push(selector);adopt();}});
 const page={locator,getByLabel(name){assert.equal(name,'募集书新版本文件');return {upload:true};},getByText(name){assert.equal(name,actual.filename);return {first:()=>({async waitFor(){}})};},async reload(){state.reloads++;state.onReload();},async waitForTimeout(){throw Error('Unexpected polling delay');}};
 const ctx={page,fixture,save(){state.saves++;},async upload(target,path){assert.equal(target.upload,true);assert.equal(path,fixture);assert.deepEqual(entry.sourceUploadStarted,actual);state.uploads++;versions.versions=[version];if(autoAdopt)adopt();},async readJson(url){
  state.calls.push(url);if(state.readError)throw state.readError;
  if(url.endsWith('/project-files/workspace')){assert.ok(generation,'Ordinary project must not request an M4 workspace');const selected=versions.current_version_id===version.version_id;return {project_id:projectId,source:selected?{...source(),project_id:sourceProject,selection_revision:versions.selection_revision,filename:actual.filename,asset:{kind:'material',pin:{...source().asset.pin,source_project_id:sourceProject,sha256:actual.sha256}}}:null};}
  if(url.endsWith('/prospectus-versions')){assert.equal(url,'/api/v1/projects/'+sourceProject+'/prospectus-versions');return structuredClone(versions);}
  assert.equal(url,'/api/v1/projects/'+sourceProject+'/materials/material?version=2');return structuredClone(state.material);
 }};
 return {ctx,entry,state,actual};
}
test('fresh ordinary project uploads, selects and reloads exact source without any M4 workspace',async t=>{
 const h=sourcePage(t);await adoptProspectusSource(h.ctx,h.entry,false);assert.equal(h.state.uploads,1);assert.equal(h.state.reloads,1);assert.deepEqual(h.entry.sourceUploadStarted,h.actual);assert.equal(h.entry.source.project_id,h.entry.projectId);assert.equal(h.entry.source.selection_revision,1);assert.equal(h.state.actions.filter(a=>a==='#confirm-prospectus-selection').length,1);assert.equal(h.state.calls.some(url=>url.includes('/workspace')),false);assert.equal(h.entry.projectCreationAttempted,true);assert.equal(h.entry.submissionRequest,undefined);
});
test('auto-adopted ordinary upload does not issue a second selection action',async t=>{
 const h=sourcePage(t,{autoAdopt:true});await adoptProspectusSource(h.ctx,h.entry,false);assert.equal(h.state.uploads,1);assert.deepEqual(h.state.actions,[]);assert.equal(h.entry.source.selection_revision,1);
});
test('ordinary source resume reuses the saved project and bytes without duplicate upload or selection',async t=>{
 const h=sourcePage(t,{existing:true});h.entry.sourceUploadStarted={...h.actual};await adoptProspectusSource(h.ctx,h.entry,false);const original=structuredClone(h.entry.source);await adoptProspectusSource(h.ctx,h.entry,false);assert.equal(h.state.uploads,0);assert.deepEqual(h.state.actions,[]);assert.deepEqual(h.entry.source,original);assert.equal(h.state.reloads,2);
});
test('unresolved ordinary upload remains failed without retransmission',async t=>{
 const h=sourcePage(t);h.entry.sourceUploadStarted={...h.actual};await assert.rejects(()=>adoptProspectusSource(h.ctx,h.entry,false),/unresolved/);assert.equal(h.state.uploads,0);assert.equal(h.state.reloads,0);assert.equal(h.entry.source,undefined);
});
test('wrong project and non-workspace HTTP errors fail before ordinary upload',async t=>{
 const wrong=sourcePage(t);wrong.state.versions.project_id='other';await assert.rejects(()=>adoptProspectusSource(wrong.ctx,wrong.entry,false),/another project/);assert.equal(wrong.state.uploads,0);
 for(const status of [404,403,503]){const h=sourcePage(t);const error=Error('Cannot read persisted state: '+status);h.state.readError=error;await assert.rejects(()=>adoptProspectusSource(h.ctx,h.entry,false),value=>value===error);assert.equal(h.state.uploads,0);}
});
test('ordinary refresh rejects changed selection, source bytes and missing material',async t=>{
 for(const change of [h=>h.state.versions.selection_revision++,h=>h.state.versions.current_version_id='other',h=>h.state.versions.versions[0].sha256=otherHash,h=>h.state.material.byte_size--,h=>h.state.readError=Error('Cannot read persisted state: 404')]){const h=sourcePage(t,{existing:true});h.state.onReload=()=>change(h);await assert.rejects(()=>adoptProspectusSource(h.ctx,h.entry,false));assert.equal(h.state.uploads,0);assert.ok(h.entry.source,'Keep the original binding when refresh fails');assert.deepEqual(h.state.actions,[]);}
});
test('generation still reads a real workspace and its source project',async t=>{
 const h=sourcePage(t,{generation:true,existing:true});await adoptProspectusSource(h.ctx,h.entry,true);assert.equal(h.entry.source.project_id,'source-project');assert.ok(h.state.calls.filter(url=>url.endsWith('/project-files/workspace')).length>=3);assert.equal(h.state.uploads,0);
 const absent=sourcePage(t,{generation:true});absent.state.readError=Error('Cannot read persisted state: 404');await assert.rejects(()=>adoptProspectusSource(absent.ctx,absent.entry,true),/404/);assert.deepEqual(absent.state.calls,['/api/v1/projects/navigation-project/project-files/workspace']);assert.equal(absent.state.uploads,0);
});
test('verifies workbook upload bytes separately from parsed catalogue hash',()=>{
 const request={material:source().asset.pin,scope:'due_diligence'},m=material();assert.equal(assertCatalogueUpload(request,m,expected).sha256,hash);assert.notEqual(catalogue().sha256,hash);
 assert.throws(()=>assertCatalogueUpload({...request,scope:'all'},m,expected));assert.throws(()=>assertCatalogueUpload({...request,material:{...request.material,sha256:otherHash}},m,expected));assert.throws(()=>assertCatalogueUpload(request,{...m,byte_size:1},expected));
});
test('batch validation preserves selected IDs, exact source pin and catalogue',()=>{
 const e=saved(),b=batch(e);assert.equal(assertWorkpaperBatch(b,e,{complete:true}),b);
 for(const mutate of [v=>v.batch_id=e.batchId,v=>v.catalogue_id='other',v=>v.items.pop(),v=>v.items[0].entry.id='other',v=>v.items[0].entry.title='other',v=>v.items[0].entry.path='other',v=>v.items[0].entry.code='other',v=>v.items[1].entry=v.items[0].entry,v=>v.source.selection_revision++,v=>v.source.version_id='other',v=>v.source.asset.pin.sha256=otherHash,v=>v.source.asset.pin.material_id='other',v=>v.source.asset.pin.material_version++,v=>v.source.asset.pin.source_project_id='other']){const v=batch(e);mutate(v);assert.throws(()=>assertWorkpaperBatch(v,e,{complete:true}));}
 assert.throws(()=>assertWorkpaperBatch(b,{...e,expectedItemIds:[]},{complete:true}));assert.throws(()=>assertWorkpaperBatch(b,{...e,source:undefined},{complete:true}));
});
test('partial, cancelled, paused and unfinished batches never pass completion',()=>{
 const e=saved();for(const state of ['partial','cancelled','paused','queued','running']){const b=batch(e);b.state=state;assert.throws(()=>assertWorkpaperBatch(b,e,{complete:true}));assert.equal(assertWorkpaperBatch(b,e),b);}
 for(const state of ['queued','running','failed','cancelled']){const b=batch(e);b.items[0].state=state;assert.throws(()=>assertWorkpaperBatch(b,e,{complete:true}));}
});
test('accepted receipts recover package and workpaper identities without accepting a changed receipt',()=>{
 const e=saved(),body={batch_id:e.batchId,workpapers:batch(e)},resume={packageBatchId:e.batchId,workpaperBatchId:e.workpaperBatchId,submissionReceipt:{body}};recoverWorkpaperReceipt(resume);assert.equal(resume.batchId,e.batchId);assert.equal(resume.workpaperBatchId,e.workpaperBatchId);assert.deepEqual(resume.fileGenerationReceipt,body);
 for(const property of ['batchId','packageBatchId','workpaperBatchId'])assert.throws(()=>recoverWorkpaperReceipt({...resume,[property]:'other'}));assert.throws(()=>recoverWorkpaperReceipt({submissionReceipt:{body:{batch_id:'only-package'}}}));
});
test('integrity verifies the saved run, one issuer and the exact five official sites',()=>{
 const e={runId:'integrity-run',issuerName:issuer};assert.equal(assertIntegrityRound(round(),e).id,'issuer');
 for(const mutate of [r=>r.run_id='other',r=>r.state='failed',r=>r.operation='export',r=>r.manifest.draft.subjects[0].name='other',r=>r.manifest.draft.subjects[0].role='other',r=>r.manifest.draft.subjects.push({...r.manifest.draft.subjects[0]}),r=>r.manifest.draft.site_ids[0]='other',r=>r.records.pop(),r=>r.records[0].subject_id='other',r=>r.records[0].site_id=r.records[1].site_id]){const r=round();mutate(r);assert.throws(()=>assertIntegrityRound(r,e));}
});
test('only actual official result captures for the issuer become verification candidates',()=>{
 const r=round();assert.equal(verifiedCaptureCandidates(r,issuer).length,5);
 for(const mutate of [x=>x.search_performed=false,x=>x.query='其它企业',x=>x.status='query_failed',x=>x.browser.outcome='blocked',x=>x.browser.outcome='unverified',x=>x.browser.captures[0].kind='blocker',x=>x.browser.captures[0].url='https://sse.com.cn.example.org/',x=>x.browser.captures[0].url='javascript:void(0)',x=>x.browser.captures[0].screenshot_sha256='bad',x=>x.browser.captures[0].id='']){const invalid=round();invalid.records.forEach(mutate);assert.deepEqual(verifiedCaptureCandidates(invalid,issuer),[]);}
});
test('workpaper readState polls only its batch endpoint and preserves item runs',async()=>{
 const e=saved(),b=batch(e),urls=[];b.state='running';b.items[2].state='running';b.items[2].stage='delivering';let saves=0;
 const flows=extendedFlows({readJson:async url=>{urls.push(url);return b;},save:()=>saves++});assert.deepEqual(await flows[e.id].readState(e),{state:'running',stage:'delivering'});assert.deepEqual(urls,['/api/v1/projects/navigation-project/workpapers/batches/workpaper-batch']);assert.equal(urls.some(u=>u.includes('/runs/')),false);assert.equal(e.itemRunIds.length,5);assert.equal(e.batchState,'running');assert.equal(saves,1);
 b.batch_id='package-batch';await assert.rejects(()=>flows[e.id].readState(e));assert.equal(saves,1);
});
test('existing accepted tasks in submit phase never upload, create or submit again',async()=>{
 const forbidden=()=>{throw Error('Unexpected browser/model/submission action');};
 const page=new Proxy({},{get:()=>forbidden}),flows=extendedFlows({page,report,fixtures:{workpaperRecipe:recipe,integrityRecipe},save:()=>{},upload:forbidden,submit:forbidden,readJson:forbidden,waitRun:forbidden,download:forbidden});
 const e=saved();await flows['workpaper-dongying'](e,'submit');await flows['integrity-dongying'](integrityEntry(),'submit');await assert.rejects(()=>flows['integrity-dongying']({runId:'integrity-run'},'submit'),/no original scope revision/);
 const resumed=saved();delete resumed.batchId;resumed.submissionReceipt={body:{batch_id:'package-batch',workpapers:batch(resumed)}};await flows['workpaper-dongying'](resumed,'submit');assert.equal(resumed.batchId,'package-batch');
});
test('uncertain project receipts fail closed before any upload or paid submission',async()=>{
 const forbidden=()=>{throw Error('Unexpected side effect');},flows=extendedFlows({page:{goto:forbidden},fixtures:{workpaperRecipe:recipe},save:forbidden,upload:forbidden,submit:forbidden});
 await assert.rejects(()=>flows['workpaper-dongying']({projectCreationAttempted:true},'submit'),/receipt is unknown/);
});
test('workpaper check derives trusted output mapping before one ZIP download per driver pass',async()=>{
 const e=saved(),b=batch(e),events=[];let downloads=0;
 const locator={locator(){return this;},async waitFor(){},async innerText(){return '5';}};
 const expectedMap=e.selectedWorkpapers.map(item=>({entryId:item.id,archivePath:item.path,disposition:'generated',sha256:hash}));
 const flows=extendedFlows({page:{async goto(url){assert.ok(url.includes('batch=workpaper-batch'));},locator(){return locator;}},fixtures:{workpaperRecipe:recipe},save(){events.push('save');},readJson:async url=>{assert.equal(url,'/api/v1/projects/navigation-project/workpapers/batches/workpaper-batch');return b;},mapWorkpapers:async value=>{assert.equal(value,b);events.push('map');return structuredClone(expectedMap);},download:async(_,role,entry)=>{assert.equal(role,'workpaper.zip');assert.deepEqual(entry.expectedWorkpapers,expectedMap);assert.equal(entry.batchState,'complete');downloads++;events.push('download');}});
 await flows[e.id](e,'check');assert.equal(downloads,1);assert.ok(events.indexOf('map')<events.indexOf('download'));await flows[e.id](e,'check');assert.equal(downloads,2);
 b.state='partial';await assert.rejects(()=>flows[e.id](e,'check'));assert.equal(downloads,2);
});
test('integrity verifies each capture before recording pairs and downloads once per check',async()=>{
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2]),r=round(),entry=integrityEntry();
 r.artifacts=[{kind:'company',artifact_id:'report'}];for(const record of r.records)record.browser.captures[0].screenshot_sha256=createHash('sha256').update(bytes).digest('hex');
 const locator=selector=>({locator:child=>locator(child),getByRole(){return this;},async waitFor(){},async getAttribute(){return 'open';},async click(){},async innerText(){return selector.includes('amounts')?visibleSettlement(r).amountsText:visibleSettlement(r).reasonText;},async evaluateAll(){return visibleSettlement(r).items;}});let downloads=0,verified=0;
 const page={async goto(){},locator,request:{async get(url){assert.ok(url.includes('/integrity/runs/integrity-run/captures/'));return {ok:()=>true,body:async()=>{verified++;return bytes;}};}}};
 const flows=extendedFlows({page,report,fixtures:{integrityRecipe},save:()=>{},waitRun:async run=>assert.equal(run,r.run_id),readJson:async()=>({rounds:[r]}),download:async(_,role,e)=>{assert.equal(role,'integrity.docx');assert.equal(verified%5,0);assert.equal(e.integrityVerifiedPairs.length,5);downloads++;}});
 await flows['integrity-dongying'](entry,'check');assert.equal(downloads,1);assert.deepEqual(entry.integrityVerifiedPairs,INTEGRITY_SITE_IDS.map(site_id=>({subject_id:'issuer',site_id})));await flows['integrity-dongying'](entry,'check');assert.equal(downloads,2);assert.equal(entry.integrityBillingPageEvidence.observations.length,2);
 r.records[0].browser.captures[0].screenshot_sha256=otherHash;await assert.rejects(()=>flows['integrity-dongying'](entry,'check'));assert.equal(downloads,2);assert.deepEqual(entry.integrityVerifiedPairs,[]);
});
