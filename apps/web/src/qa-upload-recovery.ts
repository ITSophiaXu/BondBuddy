import {UserFacingError} from './user-facing-error.js';
import {schemas,type ProjectFileAsset} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from './api.js';
import {QaRecoveryCache,type QaRecoveryValue,type QaRecoveryCacheStorage} from './qa-recovery-cache.js';
import {qaRecoveryDigest} from './qa-recovery-journal.js';
import {qaAssetKey} from './qa-continuation.js';
import {validateUploadMaterial,type UploadRecoveryJson,type UploadRecoveryRecord,type UploadRecoveryStorage} from './upload-recovery.js';

export type QaUploadKind='source'|'supplement';
export type QaUploadItem={id:string;declaration:Dto<'UploadCreateRequest'>;material?:Dto<'MaterialResponse'>;applied:boolean};
// Separate versioned envelopes preserve large QA drafts. The existing strict
// qa-recovery-cache-v1 schema is unchanged; no unknown field is discarded.
export type QaUploadEnvelope={version:1;owner:string;project:string;id:string;kind:QaUploadKind;digest:string;
 base:QaRecoveryValue;prepareRequestId?:string;handedOff:boolean;items:QaUploadItem[]};
type Result<T>={status:'valid';value:T}|{status:'invalid'|'unavailable'|'conflict';value?:undefined};
const validId=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v:unknown,required:string[],optional:string[]=[]):v is Record<string,unknown>=>object(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
class Slot implements QaRecoveryCacheStorage{constructor(public raw:string|null=null){}getItem(){return this.raw;}setItem(_k:string,v:string){this.raw=v;}removeItem(){this.raw=null;}}
function normalizedBase(value:unknown,owner:string,project:string):QaRecoveryValue|undefined{
 const cache=new QaRecoveryCache(owner,project,new Slot());const result=cache.save(value as QaRecoveryValue);
 return result.status==='valid'&&!result.value.pending?copy(result.value):undefined;
}
const media={doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} as const;
export function qaUploadMedia(filename:string,kind:QaUploadKind){const ext=filename.split('.').at(-1)?.toLowerCase() as keyof typeof media;return kind==='source'&&!['doc','docx','pdf'].includes(ext)?undefined:media[ext];}
function declaration(value:unknown,kind:QaUploadKind):value is Dto<'UploadCreateRequest'>{
 return Value.Check(schemas.UploadCreateRequest,value)&&value.role==='other'&&value.byte_size>0&&value.byte_size<=100*1024*1024&&qaUploadMedia(value.filename,kind)===value.media_type;
}
function identity(e:Omit<QaUploadEnvelope,'digest'>|QaUploadEnvelope){return {version:1,owner:e.owner,project:e.project,id:e.id,kind:e.kind,base:e.base,
 ...(e.prepareRequestId?{prepareRequestId:e.prepareRequestId}:{}),items:e.items.map(({id,declaration})=>({id,declaration}))};}
function normalize(value:unknown,owner:string,project:string):QaUploadEnvelope|undefined{
 if(!exact(value,['version','owner','project','id','kind','digest','base','handedOff','items'],['prepareRequestId'])||value.version!==1||value.owner!==owner||value.project!==project||
  !validId(value.id)||!['source','supplement'].includes(value.kind as string)||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest)||typeof value.handedOff!=='boolean'||!Array.isArray(value.items))return;
 const kind=value.kind as QaUploadKind,base=normalizedBase(value.base,owner,project);if(!base||kind==='supplement'&&!base.draft.preparation_id&&!base.draft.source)return;
 if(kind==='source'?!validId(value.prepareRequestId)||value.items.length!==1:Object.hasOwn(value,'prepareRequestId')||value.handedOff||!value.items.length||value.items.length>50)return;
 const items:QaUploadItem[]=[];let gap=false;
 for(const item of value.items){
  if(!exact(item,['id','declaration','applied'],['material'])||!validId(item.id)||!declaration(item.declaration,kind)||typeof item.applied!=='boolean'||item.applied&&!item.material||gap&&item.applied)return;
  if(!item.applied)gap=true;let material:Dto<'MaterialResponse'>|undefined;
  try{if(Object.hasOwn(item,'material'))material=validateUploadMaterial(item.declaration,item.material);}catch{return;}
  items.push({id:item.id,declaration:copy(item.declaration),applied:item.applied,...(material?{material}:{})});
 }
 if(new Set(items.map(i=>i.id)).size!==items.length||kind==='source'&&value.handedOff&&!items[0].material)return;
 const result:QaUploadEnvelope={version:1,owner,project,id:value.id,kind,digest:value.digest,base,handedOff:value.handedOff,items,...(kind==='source'?{prepareRequestId:value.prepareRequestId as string}:{})};
 if(qaRecoveryDigest(canonical(identity(result)))!==result.digest)return;return result;
}
export function qaUploadEnvelope(owner:string,project:string,kind:QaUploadKind,base:QaRecoveryValue,declarations:Dto<'UploadCreateRequest'>[]):QaUploadEnvelope{
 const e:Omit<QaUploadEnvelope,'digest'>={version:1,owner,project,id:crypto.randomUUID(),kind,base:copy(base),handedOff:false,
  ...(kind==='source'?{prepareRequestId:crypto.randomUUID()}:{}),items:declarations.map(declaration=>({id:crypto.randomUUID(),declaration:copy(declaration),applied:false}))};
 const value={...e,digest:qaRecoveryDigest(canonical(identity(e)))};const checked=normalize(value,owner,project);if(!checked)throw new UserFacingError('无法核实原问答准备与上传范围。');return checked;
}
export function qaUploadContext(e:QaUploadEnvelope,index:number):UploadRecoveryJson{return {version:1,kind:e.kind,envelope:e.id,digest:e.digest,index};}
export function qaUploadRecordMatches(e:QaUploadEnvelope,index:number,r:UploadRecoveryRecord){
 const item=e.items[index];return !!item&&r.id===item.id&&r.owner===e.owner&&r.projectId===e.project&&r.purpose===`qa-${e.kind}`&&r.declaration.role==='other'&&
  canonical(r.declaration)===canonical(item.declaration)&&canonical(r.context)===canonical(qaUploadContext(e,index));
}
export function qaUploadAsset(project:string,m:Dto<'MaterialResponse'>):ProjectFileAsset{return {kind:'material',pin:{source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256}};}
/** Parsing can enrich the receipt after upload; only immutable file identity must match. */
export function qaUploadMaterialMatches(a:Dto<'MaterialResponse'>,b:Dto<'MaterialResponse'>):boolean{
 return a.material_id===b.material_id&&a.material_version===b.material_version&&a.upload_id===b.upload_id&&
  a.sha256===b.sha256&&a.byte_size===b.byte_size&&a.media_type===b.media_type&&a.role===b.role;
}
export function qaUploadExpected(e:QaUploadEnvelope,include?:number):QaRecoveryValue{
 const base=copy(e.base);for(const [index,item] of e.items.entries())if((item.applied||index===include)&&item.material){
  const asset=qaUploadAsset(e.project,item.material);
  if(e.kind==='source'){base.draft.source=asset;base.draft.preparation_id=null;base.draft.questions=[];delete base.draft.included_followup_of;base.draft.materials=base.draft.materials.filter(a=>qaAssetKey(a)!==qaAssetKey(asset));}
  else if(!base.draft.materials.some(a=>qaAssetKey(a)===qaAssetKey(asset)))base.draft.materials.push(asset);
 }return base;
}
export const qaUploadSame=(a:QaRecoveryValue,b:QaRecoveryValue)=>canonical(a)===canonical(b);

/** A dedicated envelope per original batch. Reading never mutates QA or uploads. */
export class QaUploadJournal{
 private storage?:UploadRecoveryStorage;private prefix?:string;
 constructor(private owner:string,private project:string,storage?:UploadRecoveryStorage){
  if(![owner,project].every(validId))return;this.prefix=`bb-qa-upload-v1:${encodeURIComponent(owner)}:${encodeURIComponent(project)}:`;
  try{this.storage=storage??globalThis.localStorage;}catch{/* Explicit unavailable. */}
 }
 readAll():Result<QaUploadEnvelope[]>{
  if(!this.prefix)return {status:'invalid'};if(!this.storage)return {status:'unavailable'};
  try{
   const values:QaUploadEnvelope[]=[],keys:string[]=[],length=this.storage.length;
   for(let i=0;i<length;i++){const key=this.storage.key(i);if(key?.startsWith(this.prefix))keys.push(key);}
   if(this.storage.length!==length||new Set(keys).size!==keys.length)return {status:'unavailable'};
   for(const key of keys){const raw=this.storage.getItem(key);if(raw===null||raw.length>50000000)return {status:'invalid'};
    const e=normalize(JSON.parse(raw),this.owner,this.project);if(!e||key!==this.prefix+encodeURIComponent(e.id)||this.storage.getItem(key)!==raw)return {status:'invalid'};values.push(e);
   }return {status:'valid',value:values};
  }catch{return {status:'unavailable'};}
 }
 save(value:QaUploadEnvelope,expected:QaUploadEnvelope|null):Result<QaUploadEnvelope>{
  const e=normalize(value,this.owner,this.project);if(!this.prefix||!e)return {status:'invalid'};if(!this.storage)return {status:'unavailable'};
  const all=this.readAll();if(all.status!=='valid')return all;const previous=all.value.find(v=>v.id===e.id);
  if(expected===null?!!previous:!previous||canonical(previous)!==canonical(expected)||previous.digest!==e.digest)return {status:'conflict'};
  try{const key=this.prefix+encodeURIComponent(e.id),raw=JSON.stringify(e);if(raw.length>50000000)return {status:'invalid'};this.storage.setItem(key,raw);
   return this.storage.getItem(key)===raw?{status:'valid',value:copy(e)}:{status:'unavailable'};
  }catch{return {status:'unavailable'};}
 }
 remove(value:QaUploadEnvelope):Result<null>{
  const all=this.readAll();if(all.status!=='valid')return all;const previous=all.value.find(v=>v.id===value.id);
  if(!previous||canonical(previous)!==canonical(value)||!this.prefix||!this.storage)return {status:'conflict'};
  try{const key=this.prefix+encodeURIComponent(value.id);this.storage.removeItem(key);return this.storage.getItem(key)===null?{status:'valid',value:null}:{status:'unavailable'};}catch{return {status:'unavailable'};}
 }
}
