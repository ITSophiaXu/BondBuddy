import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {expect,type Page,type Route} from '@playwright/test';
import {Type} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,ProjectFileVersionSchema,schemas,type ProjectDocumentType,type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {fixture as returnFixture,install as installReturn,collection as returnCollection,assertFixture as assertReturn,
  assertNoBusiness as assertReturnNoBusiness,editedFile,fileKey,filesRoute,gate,ids,navigate,ready,uploadJournal} from './project-file-return-fixtures';
import {businessCalls,hash} from './word-roundtrip-fixtures';

export {editedFile,fileKey,filesRoute,gate,ids,navigate,ready,uploadJournal};
export const filesHash='#/projects/'+ids.root+'/files';
export const checkingRun='status-current-underwriter-check';
type Collection=Dto<'ProjectFilesResponse'>;
type ApiStatus=ProjectFileVersion['consistency']['status'];
const registryResponse=Type.Object({files:Type.Array(ProjectFileVersionSchema)},{additionalProperties:false});
const json=(route:Route,status:number,value:unknown)=>route.fulfill({status,json:fixtureBody(route,value)});
const failure=(route:Route)=>json(route,503,{code:'DATA_UNAVAILABLE',message:'Synthetic file status read unavailable',retryable:true,
  correlation_id:'project-file-status',field_errors:[]});

/** Explicit server main-state projections, not a copy of the production group
 * classifier. The inherited init result contains both conflict and manual;
 * registry, checks and mixed collection remain distinct HTTP resources. */
export function fixture(){
  const s=returnFixture();s.rootProject.name='合成项目文件状态项目';
  const statuses:Record<ProjectFileVersion['document_type'],ApiStatus>={workpaper:'unchecked',init:'conflict',issuer:'manual',financial:'unchecked',credit:'stale',proceeds:'updated',
    underwriter:'checking',legal:'consistent',application:'conflict',recommendation:'manual',private_summary:'consistent',annual:'unchecked',semiannual:'consistent'};
  for(const v of s.registry)v.consistency={status:statuses[v.document_type],count:statuses[v.document_type]==='conflict'?1:0,
    check_run_id:['unchecked','updated'].includes(statuses[v.document_type])?null:s.check.run_id};
  const underwriter=s.registry.find(v=>v.document_type==='underwriter')!;underwriter.consistency.check_run_id=checkingRun;
  s.checks.push({...structuredClone(s.check),run_id:checkingRun,state:'queued',stage:'queued',sha256:null,result:null,updates:[],
    files:[{file_id:underwriter.file_id,file_version_id:underwriter.version_id,filename:underwriter.filename,sequence:underwriter.sequence}]});
  // A historical manual version must not inflate the current-file review count.
  const financial=s.registry.find(v=>v.document_type==='financial')!,old=structuredClone(financial);
  financial.sequence=2;financial.version_id='status-financial-current-v2';financial.version_count=2;
  old.version_id='status-financial-old-v1';old.filename='历史财务人工事项_V1.docx';old.latest=false;old.version_count=2;
  old.asset={kind:'material',pin:{source_project_id:ids.root,material_id:'status-financial-old-material',material_version:1,sha256:hash('historical financial')}};
  old.consistency={status:'manual',count:0,check_run_id:s.check.run_id};s.registry.push(old);
  return Object.assign(s,{statusRegistryFailure:false,statusRegistryReads:0,statusRegistryReplies:0,
    statusRegistryGate:undefined as Promise<void>|undefined,registryProjection:undefined as ProjectFileVersion[]|undefined,
    collectionProjection:undefined as Collection|undefined,statusRegistryResponses:[] as ProjectFileVersion[][]});
}
export type State=ReturnType<typeof fixture>;
export function latest(s:State,type:ProjectDocumentType){const matches=s.registry.filter(v=>v.latest&&v.document_type===type);expect(matches).toHaveLength(1);return matches[0];}
export function familyKey(s:State,type:ProjectDocumentType){return 'project-file:'+latest(s,type).file_id;}
export function collection(s:State):Collection{const result=structuredClone(s.collectionProjection??returnCollection(s));expect(Value.Check(schemas.ProjectFilesResponse,result)).toBe(true);return result;}
export function status(s:State,type:ProjectDocumentType,value:ApiStatus,run:string|null=s.check.run_id){
  latest(s,type).consistency={status:value,count:value==='conflict'?1:0,check_run_id:run};
}
/** A generated latest issuer draft can retain manual items from its original
 * check. This is a schema-valid HTTP projection, not a worker simulation. */
export function deliveredManual(s:State){
  const previous=latest(s,'issuer');previous.latest=false;previous.version_count=2;
  const run='status-issuer-delivery-run',clean='status-issuer-clean-v2',revision='status-issuer-revision-v2';
  const fresh:ProjectFileVersion={...structuredClone(previous),version_id:'status-issuer-delivered-v2',sequence:2,latest:true,
    filename:'发行人基本情况_已生成V2.docx',run_id:run,asset:{kind:'artifact',pin:{source_project_id:ids.root,artifact_id:clean,artifact_version:1,sha256:hash('issuer clean')}},
    revision_asset:{kind:'artifact',pin:{source_project_id:ids.root,artifact_id:revision,artifact_version:1,sha256:hash('issuer revision')}},
    consistency:{status:'manual',count:0,check_run_id:s.check.run_id}};
  s.registry.push(fresh);s.check.updates.push({file_version_id:previous.version_id,issue_ids:['status-issuer-accepted-conflict'],run_id:run,state:'succeeded',new_version_id:fresh.version_id});
  const result=s.check.result!.files.find(f=>f.file_version_id===previous.version_id)!;
  result.status='conflict';result.findings.push({...structuredClone(result.findings[0]),id:'status-issuer-accepted-conflict',kind:'conflict',replacement:'合成已接受的新措辞'});
  return fresh;
}
export async function install(page:Page,s=fixture()){
  await installReturn(page,s);
  await page.route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length);
    if(request.method()==='GET'&&path===`/projects/${ids.root}/project-files/checks/status-check-older-than-public-window`){
      s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});
      return json(route,404,{code:'NOT_FOUND'});
    }
    if(request.method()!=='GET'||![`/projects/${ids.root}/files`,`/projects/${ids.root}/project-files`].includes(path))return route.fallback();
    if(!s.authenticated||s.owner!==ids.owner)return route.fallback();
    s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});
    try{
      if(path.endsWith('/files')){
        s.readFiles++;const response=collection(s),failed=s.filesFailure;
        // Freeze the reply before the gate: a genuine old response can arrive
        // after a new native filter/search intent without reading new state.
        await s.filesGate;if(failed){s.fileReplies++;return failure(route);}
        await json(route,200,response);s.fileReplies++;return;
      }
      s.statusRegistryReads++;const response={files:structuredClone(s.registryProjection??s.registry)},failed=s.statusRegistryFailure;
      expect(Value.Check(registryResponse,response)).toBe(true);s.statusRegistryResponses.push(structuredClone(response.files));
      await s.statusRegistryGate;if(failed){s.statusRegistryReplies++;return failure(route);}
      await json(route,200,response);s.statusRegistryReplies++;
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return failure(route);}
  });return s;
}
export async function open(page:Page,s=fixture(),entry=filesHash){
  await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto('/'+entry);
  await expect(page.locator('#file-list')).toBeVisible();await ready(page);await expect(page.locator('#pw-file-status')).toBeVisible();return s;
}
export function assertFixture(s:State){
  assertReturn(s);expect(Value.Check(schemas.ProjectFilesResponse,collection(s))).toBe(true);
  for(const response of s.statusRegistryResponses)expect(Value.Check(registryResponse,{files:response})).toBe(true);
  for(const check of s.checks)expect(Value.Check(ProjectFileCheckSchema,check)).toBe(true);
}
export function noBusiness(s:State){assertReturnNoBusiness(s);assertFixture(s);}
export function noExecution(s:State){
  expect(businessCalls(s)).toEqual([]);expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);
  expect(s.checkRequests).toEqual([]);expect(s.updatePosts).toEqual([]);assertFixture(s);
}
export {hash};
