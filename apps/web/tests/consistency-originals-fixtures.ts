import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import {expect,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,ProjectFileVersionSchema,projectFileSchemas,type ProjectFileCheck,type ProjectFileFinding,type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {appendMaterial,assertFixture as assertWord,docx,downloadBytes,editedFile,fixture as wordFixture,hash,ids,install as installWord,mime,now,originalBytes,writeCalls} from './word-roundtrip-fixtures';

export {docx,downloadBytes,editedFile,hash,ids,mime,originalBytes,writeCalls};
export const checkId='consistency-originals-checked-v1';
export const issuerVersion='word-issuer-v1',issuerFamily='word-issuer-family';
export const base=`/projects/${ids.root}`;
export const cacheKey='bondbuddy:file-consistency:'+encodeURIComponent(ids.owner)+':'+encodeURIComponent(ids.root);
export type DownloadTarget='artifact'|'material'|'source';
export type DownloadFault='id'|'version'|'hash'|'bytes'|'missing'|'run-id'|'run-response-id'|'run-project'|'run-state';
export type ContextFault='unreadable'|'duplicate-check'|'duplicate-file'|'wrong-family'|'wrong-sequence'|'missing-version'|'registry-unreadable'|'collection-mismatch'|'duplicate-collection';
type Options={historical?:boolean;dropUpdateOnce?:boolean;dropCheckOnce?:boolean;contextFault?:ContextFault};
type UpdatePost={checkId:string;body:Dto<'ProjectFileUpdateRequest'>};
const json=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:fixtureBody(route,body)});
const failure=(route:Route,status=503)=>json(route,status,{code:status===404?'NOT_FOUND':'DATA_UNAVAILABLE',message:'Synthetic pinned read unavailable',retryable:status>=500,correlation_id:'consistency-originals',field_errors:[]});

// Extend the already closed real-OOXML/import-CAS producer. No old helper is
// changed, and no worker, external Word application or settlement is modelled.
export function fixture(options:Options={}){
  const s=wordFixture();s.rootProject.name='合成人工事项原稿往返项目';
  const finding=(manual:boolean):ProjectFileFinding=>({id:manual?'manual-approval':'confirmed-wording',target_span_id:'p0',
    original:'原审批口径必须保留。',replacement:manual?null:'当前募集说明书，2026年10月固定依据。',
    source_span_id:manual?null:'p0',source_quote:manual?'':'当前募集说明书，2026年10月固定依据。',source_location:manual?'':'合成募集书第1段',
    target_location:'合成原稿第1段',reason:manual?'审批口径尚待人工核实；自动更新不能消除这一事项。':'固定募集书依据与关联文件审批措辞需同步核对；引文来自实际合成OOXML。',field:manual?'审批依据':'合成审批措辞',period:'2026年度',unit:'',kind:manual?'manual':'conflict'});
  const check:ProjectFileCheck={run_id:checkId,state:'succeeded',stage:'completed',created_at:now,source:structuredClone(s.source),stale:false,
    sha256:hash('synthetic-originals-check'),updates:[],files:s.registry.map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence})),
    result:{version:'project-file-check-v1',files:s.registry.map(v=>({file_version_id:v.version_id,status:v.file_id===ids.family?'conflict':'manual',
      coverage:'合成检查范围；人工事项仍待核实，不代表新稿已检查。',findings:v.file_id===ids.family?[finding(false),finding(true)]:[{...finding(true),id:'manual-issuer',original:'发行人基本情况，第二类当前项目文件。'}],links:[]}))}};
  s.checks=[check];for(const v of s.registry)v.consistency={status:v.file_id===ids.family?'conflict':'manual',count:v.file_id===ids.family?1:0,check_run_id:checkId};
  const pinnedMaterials=new Map([...s.materials.values()].map(m=>[m.project+':'+m.dto.material_id+':'+m.dto.material_version,{...m,dto:structuredClone(m.dto),bytes:Buffer.from(m.bytes)}]));
  if(options.historical)appendMaterial(s,docx('当前 V2 已保存；本轮检查仍固定原 V1。'),'立项报告当前稿_V2.docx');
  const state=Object.assign(s,{originalsOptions:options,check,faults:{} as Partial<Record<DownloadTarget,DownloadFault>>,pinnedMaterials,
    contextFault:options.contextFault,updatePosts:[] as UpdatePost[],updateReceipts:new Map<string,UpdatePost>(),checkReceipts:new Map<string,{body:Dto<'ProjectFileCheckRequest'>;runId:string}>(),
    checkReads:0,checkReadGate:undefined as Promise<void>|undefined,
    updateDropRemaining:!!options.dropUpdateOnce,checkDropRemaining:!!options.dropCheckOnce,downloadResponses:[] as {target:DownloadTarget;kind:'metadata'|'bytes'|'run';version:number|null}[]});
  return state;
}
export type State=ReturnType<typeof fixture>;
export const checkRoute=()=>`/#consistency?project=${ids.root}&run=${checkId}&file=${ids.version}&return_project=${ids.root}`;
export const filesRoute=(extra='')=>`/#/projects/${ids.root}/files?file=${ids.family}&version=${ids.version}&check=${checkId}${extra}`;
export function replaceMaterial(s:State){
  const current=s.registry.find(v=>v.version_id===issuerVersion)!,pin=current.asset;
  if(pin.kind!=='material')throw new Error('Expected material pin');
  const old=s.materials.get(pin.pin.material_id)!;s.pinnedMaterials.set(old.project+':'+old.dto.material_id+':1',{...old,dto:structuredClone(old.dto),bytes:Buffer.from(old.bytes)});
  const bytes=Buffer.from(docx('发行人说明同一材料的新 V2，不能代替检查时 V1。')),fresh={...old,bytes,dto:{...old.dto,material_version:2,sha256:hash(bytes),byte_size:bytes.length}};
  s.materials.set(fresh.dto.material_id,fresh);s.pinnedMaterials.set(fresh.project+':'+fresh.dto.material_id+':2',fresh);
  current.latest=false;current.version_count=2;const version:ProjectFileVersion={...structuredClone(current),version_id:'word-issuer-v2',sequence:2,latest:true,filename:'发行人说明当前V2.docx',asset:{kind:'material',pin:{...pin.pin,material_version:2,sha256:fresh.dto.sha256}},consistency:{status:'unchecked',count:0,check_run_id:null}};
  s.registry.push(version);return {version,old:old.bytes,current:bytes};
}
export function replaceSource(s:State){
  const pin=s.source.asset;if(pin.kind!=='material')throw new Error('Expected source material');
  const old=s.materials.get(pin.pin.material_id)!,bytes=Buffer.from(docx('当前新募集书 V3；检查时募集书仍是原 V2。'));
  const fresh={...old,bytes,dto:{...old.dto,material_version:2,sha256:hash(bytes),byte_size:bytes.length}};
  s.materials.set(fresh.dto.material_id,fresh);s.pinnedMaterials.set(fresh.project+':'+fresh.dto.material_id+':2',fresh);
  s.source.version_id='originals-current-source-v3';s.source.sequence=3;s.source.selection_revision++;s.source.filename='当前募集说明书_V3.docx';
  s.source.asset={kind:'material',pin:{...pin.pin,material_version:2,sha256:fresh.dto.sha256}};s.check.stale=true;return {old:old.bytes,current:bytes};
}
function collection(s:State):Dto<'ProjectFilesResponse'>{
  const sourcePin=s.source.asset;if(sourcePin.kind!=='material')throw new Error('Expected source material');
  const items:Dto<'ProjectFilesResponse'>['items']=[{file_id:sourcePin.pin.material_id,file_key:'prospectus',project_id:sourcePin.pin.source_project_id,source:'material',filename:s.source.filename,version:sourcePin.pin.material_version,display_version:s.source.sequence,sha256:sourcePin.pin.sha256,created_at:now,folder:'2',run_id:null,current:true,latest:true,version_count:1},
    ...s.registry.map(v=>({file_id:v.asset.kind==='material'?v.asset.pin.material_id:v.asset.pin.artifact_id,file_key:'project-file:'+v.file_id,project_id:v.asset.pin.source_project_id,source:v.asset.kind,filename:v.filename,version:v.asset.kind==='material'?v.asset.pin.material_version:v.asset.pin.artifact_version,display_version:v.sequence,sha256:v.asset.pin.sha256,created_at:v.created_at,folder:v.document_type==='init'?'1' as const:'4.1' as const,run_id:v.run_id,current:false,latest:v.latest,version_count:v.version_count}))];
  const target=items.find(v=>v.file_key==='project-file:'+ids.family&&v.latest)!;
  if(s.contextFault==='collection-mismatch')target.sha256=hash('wrong collection pin');
  if(s.contextFault==='duplicate-collection')items.push(structuredClone(target));
  return {project_id:ids.root,items};
}
function projectedChecks(s:State){
  const checks=structuredClone(s.checks),check=checks.find(c=>c.run_id===checkId)!;
  if(s.contextFault==='duplicate-check')checks.push(structuredClone(check));
  if(s.contextFault==='duplicate-file')check.files.push(structuredClone(check.files[0]));
  if(s.contextFault==='wrong-family')check.files[0].file_id='different-family';
  if(s.contextFault==='wrong-sequence')check.files[0].sequence=99;
  if(s.contextFault==='missing-version')check.files[0].file_version_id='missing-checked-version';
  return checks;
}
export async function install(page:Page,s=fixture()){
  await installWord(page,s);
  await page.route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),method=request.method();
    const handled=path===base+'/files'||path===base+'/project-files/checks'&&method==='GET'||path===base+'/project-files'&&method==='GET'&&s.contextFault==='registry-unreadable'||
      path===base+'/project-files/checks'&&method==='POST'&&s.originalsOptions.dropCheckOnce||path===base+'/project-files/checks/'+checkId+'/updates'&&method==='POST'||
      method==='GET'&&(path===`/artifacts/${ids.originalArtifact}`||path===`/artifacts/${ids.originalArtifact}/download`||path===`/runs/${ids.originalRun}`||new RegExp('^'+base+'/materials/[^/]+(?:/download)?$').test(path));
    if(!handled)return route.fallback();
    const body=method==='POST'?fixtureRequest(request):null;s.calls.push({owner:s.owner,method,path,search:url.search,body:structuredClone(body)});
    try{
      if(path===base+'/files'){s.readFiles++;return s.filesFailure?failure(route):json(route,200,collection(s));}
      if(path===base+'/project-files'&&s.contextFault==='registry-unreadable')return failure(route);
      if(path===base+'/project-files/checks'&&method==='GET'){s.checkReads++;await s.checkReadGate;return s.contextFault==='unreadable'?failure(route):json(route,200,{checks:projectedChecks(s)});}
      if(method==='POST'&&path.endsWith('/updates')){
        expect(Value.Check(projectFileSchemas.ProjectFileUpdateRequest,body)).toBe(true);const post:UpdatePost={checkId,body:structuredClone(body)};s.updatePosts.push(post);
        const old=s.updateReceipts.get(body.request_id);if(old){expect(post).toEqual(old);return json(route,200,{batch_id:'originals-accepted-batch'});}
        expect(body.expected_check_sha256).toBe(s.check.sha256);expect(body.files).toEqual([{file_version_id:ids.version}]);expect(body.expected_points).toBe(4500);s.updateReceipts.set(body.request_id,post);
        if(s.updateDropRemaining){s.updateDropRemaining=false;return route.abort('connectionreset');}
        return json(route,200,{batch_id:'originals-accepted-batch'});
      }
      if(method==='POST'&&path===base+'/project-files/checks'){
        expect(Value.Check(projectFileSchemas.ProjectFileCheckRequest,body)).toBe(true);s.checkRequests.push(structuredClone(body));const old=s.checkReceipts.get(body.request_id);
        if(old){expect(body).toEqual(old.body);return json(route,200,{run_id:old.runId});}
        expect(body.expected_source_version_id).toBe(s.source.version_id);const runId='originals-new-queued-check';
        s.checkReceipts.set(body.request_id,{body:structuredClone(body),runId});s.checks.unshift({run_id:runId,state:'queued',stage:'queued',created_at:now,source:structuredClone(s.source),stale:false,sha256:null,result:null,updates:[],files:s.registry.filter(v=>v.latest).map(v=>({file_id:v.file_id,file_version_id:v.version_id,filename:v.filename,sequence:v.sequence}))});
        if(s.checkDropRemaining){s.checkDropRemaining=false;return route.abort('connectionreset');}return json(route,200,{run_id:runId});
      }
      if(path.startsWith('/artifacts/')){
        const fault=s.faults.artifact,artifact=s.artifact;s.downloadResponses.push({target:'artifact',kind:path.endsWith('/download')?'bytes':'metadata',version:artifact.artifact_version});
        if(fault==='missing')return failure(route,404);
        if(path.endsWith('/download')){const bytes=Buffer.from(originalBytes);if(fault==='bytes')bytes[bytes.length-5]^=1;return route.fulfill({status:200,contentType:mime,body:bytes});}
        const dto:Dto<'ArtifactResponse'>={artifact_id:artifact.artifact_id,run_id:artifact.run_id,version:artifact.artifact_version,filename:artifact.filename,media_type:mime,sha256:artifact.sha256,quality_status:'passed',delivery_status:'available',download_url:`/api/v1/artifacts/${artifact.artifact_id}/download?grant=synthetic`,expires_at:'2099-01-01T00:00:00Z'};
        if(fault==='id')dto.artifact_id='different-artifact';if(fault==='version')dto.version++;if(fault==='hash')dto.sha256=hash('wrong artifact');if(fault==='run-id')dto.run_id='different-run';return json(route,200,dto);
      }
      if(path.startsWith('/runs/')){s.downloadResponses.push({target:'artifact',kind:'run',version:null});const run=s.run(ids.originalRun);if(s.faults.artifact==='run-response-id')run.run_id='different-response-run';if(s.faults.artifact==='run-project')run.project_id=ids.otherRoot;if(s.faults.artifact==='run-state')run.state='running';return json(route,200,run);}
      const material=path.match(new RegExp('^'+base+'/materials/([^/]+)(/download)?$'))!;
      const latest=s.materials.get(material[1]);if(!latest)return failure(route,404);
      const version=url.searchParams.has('version')?Number(url.searchParams.get('version')):latest.dto.material_version;
      const stored=s.pinnedMaterials.get(ids.root+':'+material[1]+':'+version)??(latest.dto.material_version===version?latest:undefined);
      const target:DownloadTarget=material[1]==='word-source-material'?'source':'material',fault=s.faults[target];s.downloadResponses.push({target,kind:material[2]?'bytes':'metadata',version});
      if(!stored||fault==='missing')return failure(route,404);
      if(material[2]){const bytes=Buffer.from(stored.bytes);if(fault==='bytes')bytes[bytes.length-5]^=1;return route.fulfill({status:200,contentType:mime,body:bytes});}
      const dto=structuredClone(stored.dto);if(fault==='id')dto.material_id='different-material';if(fault==='version')dto.material_version++;if(fault==='hash')dto.sha256=hash('wrong material');return json(route,200,dto);
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return failure(route,500);}
  });return s;
}
export async function open(page:Page,s=fixture(),entry:'check'|'files'='check',extra=''){
  await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto(entry==='check'?checkRoute():filesRoute(extra));
  await expect(page.locator(entry==='check'?'.fc-results':'#file-list')).toBeVisible();return s;
}
export function assertFixture(s:State){assertWord(s);for(const c of s.checks)expect(Value.Check(ProjectFileCheckSchema,c)).toBe(true);for(const v of s.registry)expect(Value.Check(ProjectFileVersionSchema,v)).toBe(true);}
