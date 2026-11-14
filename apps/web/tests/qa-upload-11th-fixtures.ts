import {serveDisabledBillingCatalog} from './billing-fixture-wire';
import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import {expect,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import {schemas} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from './billing-fixture-wire';
import {fixture,install,assertFixture,projectId,ownerId,now} from './project-qa-continuation-fixtures';

export {projectId,ownerId,otherOwnerId} from './project-qa-continuation-fixtures';
export const qaUploadUrl=`/#qa?project=${projectId}`;
export const qaUploadHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const qaUploadFile=(name='合成原补充材料.pdf')=>({name,mimeType:name.endsWith('.doc')?'application/msword':'application/pdf',buffer:Buffer.from('synthetic original QA upload bytes, not real professional evidence')});
type Upload={id:string;owner:string;declaration:Dto<'UploadCreateRequest'>;received:boolean;material?:Dto<'MaterialResponse'>};
export function qaUploadFixture(){return {qa:fixture(),uploads:new Map<string,Upload>(),missingUploads:new Set<string>(),calls:[] as {owner:string;method:string;path:string;body?:unknown;search:string}[],unexpected:[] as string[],
 lostPut:true,completeUnavailable:true,dropBeforeReceive:false,deduplicate:false,parseEnrichment:false,completeGate:undefined as (()=>Promise<void>)|undefined,activeCompletes:0};}
export type QaUploadState=ReturnType<typeof qaUploadFixture>;
function checked<K extends keyof typeof schemas>(name:K,v:unknown):asserts v is Dto<K>{expect(Value.Check(schemas[name],v),`${name}: ${JSON.stringify([...Value.Errors(schemas[name],v)])}`).toBe(true);}
async function reply<K extends keyof typeof schemas>(route:Route,name:K,body:Dto<K>,status=200){checked(name,body);return route.fulfill({status,json:fixtureBody(route,body)});}
function problem(route:Route,status:number,code:Dto<'Error'>['code']){return reply(route,'Error',{code,message:'Synthetic QA upload fault',retryable:status>=500,correlation_id:'synthetic-qa-upload-11th',field_errors:[]},status);}
export async function installQaUpload11th(page:Page,state=qaUploadFixture()){
 await install(page,state.qa);
 await page.route('**/api/v1/**',async route=>{
    if(await serveDisabledBillingCatalog(route))return;
  const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length),method=req.method(),owner=state.qa.owner;
  const match=path.match(new RegExp(`^/projects/${projectId}/materials/(uploads(?:/[^/]+/(?:bytes|complete))?|[^/]+)$`));if(!match)return route.fallback();
  const body:unknown=method==='POST'?fixtureRequest(req):undefined;state.calls.push({owner,method,path,search:url.search,...(body===undefined?{}:{body})});
  if(owner!==ownerId)return problem(route,404,'NOT_FOUND');
  if(method==='POST'&&match[1]==='uploads'){
   checked('UploadCreateRequest',body);expect(body.role).toBe('other');const id=`qa-upload-11th-${state.uploads.size+1}`;state.uploads.set(id,{id,owner,declaration:structuredClone(body),received:false});
   return reply(route,'UploadSessionResponse',{upload_id:id,state:'uploading',upload_url:`/api/v1/projects/${projectId}/materials/uploads/${id}/bytes`,expires_at:new Date(Date.now()+3600000).toISOString(),max_bytes:104857600},201);
  }
  const transfer=path.match(/\/uploads\/([^/]+)\/(bytes|complete)$/);
  if(transfer){const u=state.uploads.get(transfer[1]);if(!u||u.owner!==owner||state.missingUploads.has(u.id))return problem(route,404,'NOT_FOUND');
   if(method==='PUT'&&transfer[2]==='bytes'){
    const bytes=req.postDataBuffer()!;expect(bytes.length).toBe(u.declaration.byte_size);expect(qaUploadHash(bytes)).toBe(u.declaration.sha256);
    if(state.dropBeforeReceive){state.dropBeforeReceive=false;return route.abort('failed');}u.received=true;
    if(state.lostPut){state.lostPut=false;return route.abort('failed');}return route.fulfill({status:204});
   }
   if(method==='POST'&&transfer[2]==='complete'){
    checked('UploadCompleteRequest',body);expect(body).toEqual({sha256:u.declaration.sha256,byte_size:u.declaration.byte_size});
    if(state.completeUnavailable)return problem(route,503,'DATA_UNAVAILABLE');if(!u.received)return problem(route,422,'MATERIAL_UNREADABLE');
    state.activeCompletes++;try{await state.completeGate?.();
     const d=u.declaration;u.material??={material_id:`saved-${u.id}`,material_version:2,upload_id:state.deduplicate?'old-deduplicated-qa-upload':u.id,filename:state.deduplicate?'先前保存的相同内容.doc':d.filename,
      role:d.role,media_type:d.media_type,byte_size:d.byte_size,sha256:d.sha256,state:'persisted',persisted_at:now,error:null};
     state.qa.uploadMaterial=u.material;
     if(!state.qa.workspace.materials.some(m=>m.asset.kind==='material'&&m.asset.pin.material_id===u.material!.material_id))state.qa.workspace.materials.push({filename:u.material.filename,asset:{kind:'material',pin:{source_project_id:projectId,material_id:u.material.material_id,material_version:u.material.material_version,sha256:u.material.sha256}}});
     return reply(route,'MaterialResponse',u.material);
    }finally{state.activeCompletes--;}
   }
  }
  if(method==='GET'){
   checked('MaterialVersionQuery',Object.fromEntries(url.searchParams));const m=[...state.uploads.values()].find(u=>u.material?.material_id===match[1])?.material;
   if(m&&url.searchParams.get('version')===String(m.material_version))return reply(route,'MaterialResponse',state.parseEnrichment?{...m,parse_snapshot_id:'parsed-after-upload'}:m);return problem(route,404,'NOT_FOUND');
  }
  state.unexpected.push(`${method} ${path}`);return problem(route,500,'DATA_UNAVAILABLE');
 });return state;
}
export async function assertQaUpload11th(page:Page,state:QaUploadState){await assertFixture(page);expect(state.unexpected).toEqual([]);expect(state.qa.drafts).toEqual([]);expect(state.qa.answers).toEqual([]);}
export const qaTransportWrites=(s:QaUploadState)=>s.calls.filter(c=>c.method!=='GET');
