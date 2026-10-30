import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import {expect,type Page,type Route} from '@playwright/test';
import {schemas} from '@bondbuddy/contracts';
import {createHash} from 'node:crypto';
import type {Dto} from './billing-fixture-wire';
import {fixture,install,checked,ownerId,projectId,now} from './integrity-continuation-fixtures';

// Synthetic schema HTTP only: no official query, document inspection or paid run.
export function uploadFixture(){return Object.assign(fixture(),{
 sessions:new Map<string,{declaration:Dto<'UploadCreateRequest'>;received:boolean;material?:Dto<'MaterialResponse'>}>(),
 completes:[] as string[],puts:[] as string[],unavailable:false,putFault:undefined as 'before'|'after'|undefined,
 mismatch:undefined as 'sha256'|'byte_size'|'media_type'|'role'|undefined,deduplicate:false,
 holdComplete:undefined as Promise<void>|undefined,completeEntered:false,
 });}
export type UploadState=ReturnType<typeof uploadFixture>;
async function reply<K extends keyof typeof schemas>(route:Route,name:K,body:Dto<K>,status=200){checked(name,body);await route.fulfill({status,json:fixtureBody(route,body)});}
const problem=(route:Route,status:number,code:string,details?:object)=>route.fulfill({status,json:fixtureBody(route,{code,...(details?{details}:{})})});
export async function installUpload(page:Page,state=uploadFixture()){
 await install(page,state);
 await page.context().route('**/synthetic-integrity-eleventh-upload/**',async route=>{
  const id=new URL(route.request().url()).pathname.split('/').at(-1)!,session=state.sessions.get(id);
  expect(route.request().method()).toBe('PUT');expect(session).toBeDefined();state.uploadBytes++;state.puts.push(id);
  const bytes=route.request().postDataBuffer()!;expect(bytes.length).toBe(session!.declaration.byte_size);expect(createHash('sha256').update(bytes).digest('hex')).toBe(session!.declaration.sha256);
  const fault=state.putFault;state.putFault=undefined;if(fault==='before')return route.abort('connectionreset');session!.received=true;if(fault==='after')return route.abort('connectionreset');return route.fulfill({status:204,body:''});
 });
 await page.context().route('**/api/v1/projects/*/materials/uploads**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
  if(!path.startsWith(`/projects/${projectId}/materials/uploads`)||method!=='POST')return route.fallback();
  const body:unknown=fixtureRequest(request);state.calls.push({method,path,search:url.search,body:structuredClone(body)});
  if(state.owner!==ownerId)return problem(route,404,'NOT_FOUND');
  if(path===`/projects/${projectId}/materials/uploads`){
   checked('UploadCreateRequest',body);state.uploads.push(structuredClone(body));const id=`synthetic-eleventh-u-${state.uploads.length}`;
   state.sessions.set(id,{declaration:structuredClone(body),received:false});
   return reply(route,'UploadSessionResponse',{upload_id:id,state:'uploading',upload_url:`/synthetic-integrity-eleventh-upload/${id}`,expires_at:new Date(Date.now()+3600000).toISOString(),max_bytes:100*1024*1024},201);
  }
  const match=path.match(/\/uploads\/([^/]+)\/complete$/);expect(match).not.toBeNull();const id=match![1],session=state.sessions.get(id);state.completes.push(id);checked('UploadCompleteRequest',body);
  if(!session)return problem(route,404,'NOT_FOUND');expect(body).toEqual({byte_size:session.declaration.byte_size,sha256:session.declaration.sha256});
  state.completeEntered=true;if(state.holdComplete)await state.holdComplete;
  if(state.unavailable)return problem(route,503,'DATA_UNAVAILABLE');if(!session.received)return problem(route,422,'MATERIAL_UNREADABLE');
  if(!session.material){const d=session.declaration;session.material={material_id:'synthetic-eleventh-evidence',material_version:state.deduplicate?4:1,upload_id:state.deduplicate?'original-reused-upload-id':id,role:d.role,filename:state.deduplicate?'已保存的合成证据.pdf':d.filename,media_type:d.media_type,byte_size:d.byte_size,sha256:d.sha256,state:'persisted',persisted_at:now,error:null};state.materials.push(session.material);}
  const material=structuredClone(session.material);if(state.mismatch==='sha256')material.sha256='f'.repeat(64);if(state.mismatch==='byte_size')material.byte_size++;if(state.mismatch==='media_type')material.media_type='image/png';if(state.mismatch==='role')material.role='audit';
  return reply(route,'MaterialResponse',material);
 });
 return state;
}
