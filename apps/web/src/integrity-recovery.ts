import {billingRecoverySchemas,type BillingRecoveryDto} from './billing-recovery-wire.js';
import {int64,encodeBillingDto} from '@bondbuddy/contracts';
import {INTEGRITY_PRICE,OUTCOME_PRICE_VERSION,isOutcomePriceVersion,CommercePriceMetadataSchema,type CommercePriceMetadata,INTEGRITY_SITES,INTEGRITY_SITE_LIMIT,M4MaterialPinSchema,integritySchemas,type IntegrityDraft,type M4MaterialPin} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from './api.js';

export type IntegrityRecoveryCacheStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type IntegrityRecoveryStorage=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
export type IntegrityRecoveryJournalStorage=IntegrityRecoveryStorage;
export type IntegrityEvidenceDraft={roundId:string;subjectId:string;siteId:string;url:string;time:string;note:string;
  conclusion:'records_found'|'no_records'|'unresolved';registration?:{province:string;city:string};material?:M4MaterialPin;uploadOperationId?:string};
export type IntegrityRecoveryPending=
  | {kind:'draft';request:Dto<'IntegrityDraftRequest'>}
  | {kind:'check';request:BillingRecoveryDto<'IntegrityRunRequest'>;price?:CommercePriceMetadata}
  | {kind:'export';roundId:string;request:Dto<'IntegrityExportRequest'>}
  | {kind:'evidence';roundId:string;request:Dto<'IntegrityManualRequest'>};
export type IntegrityRecoveryValue={revision:number;draft:IntegrityDraft;sourceRun?:string;evidenceDraft?:IntegrityEvidenceDraft;pending?:IntegrityRecoveryPending};
export type IntegrityRecoveryCacheRead={status:'empty'|'invalid'|'unavailable';value?:undefined}|{status:'valid';value:IntegrityRecoveryValue};
export type IntegrityRecoveryCacheResult=IntegrityRecoveryCacheRead|{status:'conflict';value?:undefined};
export type IntegrityRecoveryJournalRead={status:'valid';values:IntegrityRecoveryValue[]}|{status:'invalid'|'unavailable';values?:undefined};
export type IntegrityRecoveryJournalResult={status:'valid';value:IntegrityRecoveryValue}|{status:'invalid'|'unavailable'|'conflict';value?:undefined};
export type IntegrityRecoveryJournalConfirm={status:'empty'|'invalid'|'unavailable'|'conflict'};
const version='integrity-recovery-cache-v1',maxRawLength=10000000;
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,required:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>=>record(value)&&
  required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const conclusion=(value:unknown)=>value==='records_found'||value==='no_records'||value==='unresolved';
const registration=(value:unknown)=>exact(value,['province','city'])&&text(value.province,200)&&text(value.city,200);
const requestUrl=(value:string)=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.port;}catch{return false;}};
function validPin(value:unknown,project:string):value is M4MaterialPin{
  return Value.Check(M4MaterialPinSchema,value)&&validId(value.source_project_id)&&value.source_project_id===project&&validId(value.material_id)&&Number.isSafeInteger(value.material_version);
}
function validDraft(value:unknown,executable=false,start=false):value is IntegrityDraft{
  if(!exact(value,['subjects','site_ids','notes'])||!text(value.notes,12000)||!Array.isArray(value.subjects)||value.subjects.length>100||
    !Array.isArray(value.site_ids)||value.site_ids.length>INTEGRITY_SITE_LIMIT||!value.site_ids.every(validId)||new Set(value.site_ids).size!==value.site_ids.length)return false;
  if(executable&&value.site_ids.some(id=>!INTEGRITY_SITES.some(site=>site.id===id)))return false;
  if(start&&(!value.subjects.length||!value.site_ids.length))return false;
  const ids=new Set<string>(),identities=new Set<string>();
  for(const subject of value.subjects){
    if(!exact(subject,['id','kind','name','identifier','role','province','city'])||!validId(subject.id)||ids.has(subject.id)||
      (subject.kind!=='company'&&subject.kind!=='person')||!['name','identifier','role','province','city'].every(key=>text(subject[key],200)))return false;
    ids.add(subject.id);
    if(executable){
      const identity=subject.kind+':'+(subject.name as string).trim()+':'+(subject.identifier as string).trim();
      if(!(subject.name as string).trim()||identities.has(identity)||subject.kind==='company'&&subject.identifier!==''&&!/^[0-9A-Z]{18}$/.test(subject.identifier as string))return false;
      if(start&&subject.kind==='person'&&!value.site_ids.some(id=>!INTEGRITY_SITES.find(site=>site.id===id)?.companyOnly))return false;
      identities.add(identity);
    }
  }
  return true;
}
function validForm(value:unknown,project:string,allowUndefined=false):value is IntegrityEvidenceDraft{
  if(!exact(value,['roundId','subjectId','siteId','url','time','note','conclusion'],['registration','material','uploadOperationId'])||
    ![value.roundId,value.subjectId,value.siteId].every(validId)||!text(value.url,4096)||!text(value.time,200)||!text(value.note,12000)||!conclusion(value.conclusion))return false;
  if(Object.hasOwn(value,'registration')&&!(allowUndefined&&value.registration===undefined)&&!registration(value.registration))return false;
  if(Object.hasOwn(value,'uploadOperationId')&&!(allowUndefined&&value.uploadOperationId===undefined)&&!validId(value.uploadOperationId))return false;
  return !Object.hasOwn(value,'material')||(allowUndefined&&value.material===undefined)||validPin(value.material,project);
}
function copyDraft(draft:IntegrityDraft):IntegrityDraft{
  return {subjects:draft.subjects.map(({id,kind,name,identifier,role,province,city})=>({id,kind,name,identifier,role,province,city})),site_ids:[...draft.site_ids],notes:draft.notes};
}
const copyPin=(pin:M4MaterialPin):M4MaterialPin=>({source_project_id:pin.source_project_id,material_id:pin.material_id,material_version:pin.material_version,sha256:pin.sha256});
const sameDraft=(a:IntegrityDraft,b:IntegrityDraft)=>JSON.stringify(copyDraft(a))===JSON.stringify(copyDraft(b));
function validValue(value:unknown,project:string,allowUndefined=false):value is IntegrityRecoveryValue{
  try{return validValueInner(value,project,allowUndefined);}catch{return false;}
}
function validValueInner(value:unknown,project:string,allowUndefined=false):value is IntegrityRecoveryValue{
  if(!exact(value,['revision','draft'],['sourceRun','evidenceDraft','pending'])||!integer(value.revision)||!validDraft(value.draft))return false;
  if(Object.hasOwn(value,'sourceRun')&&!(allowUndefined&&value.sourceRun===undefined)&&!validId(value.sourceRun))return false;
  if(Object.hasOwn(value,'evidenceDraft')&&!(allowUndefined&&value.evidenceDraft===undefined)&&!validForm(value.evidenceDraft,project,allowUndefined))return false;
  if(!Object.hasOwn(value,'pending')||(allowUndefined&&value.pending===undefined))return true;
  const pending=value.pending;
  if(!record(pending))return false;
  if(pending.kind==='draft')return exact(pending,['kind','request'])&&Value.Check(integritySchemas.IntegrityDraftRequest,pending.request)&&
    pending.request.expected_revision===value.revision&&validDraft(pending.request.draft,true)&&sameDraft(value.draft,pending.request.draft);
  if(pending.kind==='check'){
    if(!exact(pending,['kind','request'],['price'])||(Object.hasOwn(pending,'price')&&!Value.Check(billingRecoverySchemas.CommercePriceMetadata,pending.price)))return false;
    const price=pending.price as CommercePriceMetadata|undefined;
    return Value.Check(billingRecoverySchemas.IntegrityRunRequest,pending.request)&&validId(pending.request.request_id)&&pending.request.expected_revision===value.revision&&(price?.pricing_mode==='outcome_cny_v1'?isOutcomePriceVersion(pending.request.price_version)&&pending.request.price_version===(price.price_version??OUTCOME_PRICE_VERSION):pending.request.price_version===INTEGRITY_PRICE.version)&&
      (price?.pricing_mode==='outcome_cny_v1'?price.quote_status==='ready'&&price.amount_fen!==null&&int64(price.amount_fen)===int64(pending.request.expected_points)&&validId(pending.request.scope_quote_id):int64(pending.request.expected_points)===BigInt(INTEGRITY_PRICE.points))&&validDraft(value.draft,true,true);
  }
  if(pending.kind==='export')return exact(pending,['kind','roundId','request'])&&validId(pending.roundId)&&
    Value.Check(integritySchemas.IntegrityExportRequest,pending.request)&&validId(pending.request.request_id)&&pending.request.expected_evidence_ids.every(validId);
  if(pending.kind==='evidence'){
    if(!exact(pending,['kind','roundId','request'])||!validId(pending.roundId)||!Value.Check(integritySchemas.IntegrityManualRequest,pending.request))return false;
    const request=pending.request;
    // The current editable draft can differ from the original round. Preserve the
    // original body; round membership and regional official URLs need that round.
    return [request.request_id,request.subject_id,request.site_id].every(validId)&&INTEGRITY_SITES.some(site=>site.id===request.site_id)&&
      Number.isFinite(Date.parse(request.queried_at))&&requestUrl(request.url)&&!!request.note.trim()&&validPin(request.material,project)&&
      (!Object.hasOwn(request,'registration')||(allowUndefined&&request.registration===undefined)||registration(request.registration));
  }
  return false;
}
function clone(value:IntegrityRecoveryValue):IntegrityRecoveryValue{
  let pending:IntegrityRecoveryPending|undefined;
  if(value.pending?.kind==='draft')pending={kind:'draft',request:{expected_revision:value.pending.request.expected_revision,draft:copyDraft(value.pending.request.draft)}};
  if(value.pending?.kind==='check')pending={kind:'check',...(value.pending.price?{price:encodeBillingDto('commerceMetadata',value.pending.price)}:{}),request:{request_id:value.pending.request.request_id,expected_revision:value.pending.request.expected_revision,
    price_version:value.pending.request.price_version,...(value.pending.request.scope_quote_id?{scope_quote_id:value.pending.request.scope_quote_id}:{}),expected_points:value.pending.request.expected_points}};
  if(value.pending?.kind==='export')pending={kind:'export',roundId:value.pending.roundId,request:{request_id:value.pending.request.request_id,expected_evidence_ids:[...value.pending.request.expected_evidence_ids]}};
  if(value.pending?.kind==='evidence'){
    const r=value.pending.request;pending={kind:'evidence',roundId:value.pending.roundId,request:{request_id:r.request_id,subject_id:r.subject_id,site_id:r.site_id,
      queried_at:r.queried_at,url:r.url,note:r.note,conclusion:r.conclusion,material:copyPin(r.material),...(r.registration?{registration:{province:r.registration.province,city:r.registration.city}}:{})}};
  }
  const form=value.evidenceDraft;
  return {revision:value.revision,draft:copyDraft(value.draft),...(value.sourceRun!==undefined?{sourceRun:value.sourceRun}:{}),
    ...(form?{evidenceDraft:{roundId:form.roundId,subjectId:form.subjectId,siteId:form.siteId,url:form.url,time:form.time,note:form.note,conclusion:form.conclusion,
      ...(form.registration?{registration:{province:form.registration.province,city:form.registration.city}}:{}),...(form.material?{material:copyPin(form.material)}:{}),...(form.uploadOperationId!==undefined?{uploadOperationId:form.uploadOperationId}:{})}}:{}),...(pending?{pending}:{})};
}
function freeze(value:unknown){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
function frozen(value:IntegrityRecoveryValue){const copy=clone(value);freeze(copy);return copy;}
const sameValue=(a:IntegrityRecoveryValue,b:IntegrityRecoveryValue)=>JSON.stringify(clone(a))===JSON.stringify(clone(b));

/** Reading restores data only. The controller decides whether an original POST may be retried. */
export class IntegrityRecoveryCache{
  private storage?:IntegrityRecoveryCacheStorage;private key?:string;
  constructor(private owner:string,private project:string,storage?:IntegrityRecoveryCacheStorage){
    if(![owner,project].every(validId))return;
    try{this.key=`bb-integrity-recovery:${encodeURIComponent(owner)}:${encodeURIComponent(project)}`;}catch{return;}
    try{this.storage=storage??globalThis.localStorage;}catch{/* Report inaccessible storage. */}
  }
  read():IntegrityRecoveryCacheRead{
    if(!this.key)return {status:'invalid'};if(!this.storage)return {status:'unavailable'};
    let raw:string|null;try{raw=this.storage.getItem(this.key);}catch{return {status:'unavailable'};}
    if(raw===null)return {status:'empty'};if(raw.length>maxRawLength)return {status:'invalid'};
    try{const saved:unknown=JSON.parse(raw);
      if(!exact(saved,['version','owner','project','value'])||saved.version!==version||saved.owner!==this.owner||saved.project!==this.project||!validValue(saved.value,this.project))return {status:'invalid'};
      return {status:'valid',value:frozen(saved.value)};
    }catch{return {status:'invalid'};}
  }
  private compare(expected:IntegrityRecoveryValue|null):'match'|'conflict'|'unavailable'{
    const current=this.read();if(current.status==='unavailable')return 'unavailable';
    if(expected===null)return current.status==='empty'?'match':'conflict';
    return current.status==='valid'&&sameValue(current.value,expected)?'match':'conflict';
  }
  // A synchronous read/compare/write guard is not atomic across browser tabs.
  save(value:IntegrityRecoveryValue,expected?:IntegrityRecoveryValue|null):IntegrityRecoveryCacheResult{
    if(!this.key)return {status:'invalid'};
    try{
      if(!validValue(value,this.project,true)||(expected!==undefined&&expected!==null&&!validValue(expected,this.project,true)))return {status:'invalid'};
      const snapshot=frozen(value);if(!validValue(snapshot,this.project))return {status:'invalid'};if(!this.storage)return {status:'unavailable'};
      const body=JSON.stringify({version,owner:this.owner,project:this.project,value:snapshot});if(body.length>maxRawLength)return {status:'invalid'};
      if(expected!==undefined){const compared=this.compare(expected);if(compared!=='match')return {status:compared};}
      this.storage.setItem(this.key,body);if(this.storage.getItem(this.key)!==body)return {status:'unavailable'};
      return {status:'valid',value:snapshot};
    }catch{return {status:'unavailable'};}
  }
  clear(expected?:IntegrityRecoveryValue):IntegrityRecoveryCacheResult{
    if(!this.key)return {status:'invalid'};
    try{
      if(expected!==undefined&&!validValue(expected,this.project,true))return {status:'invalid'};if(!this.storage)return {status:'unavailable'};
      if(expected!==undefined){const compared=this.compare(expected);if(compared!=='match')return {status:compared};}
      this.storage.removeItem(this.key);return this.storage.getItem(this.key)===null?{status:'empty'}:{status:'unavailable'};
    }catch{return {status:'unavailable'};}
  }
}

class Slot implements IntegrityRecoveryCacheStorage{
  constructor(public raw:string|null=null){}getItem(){return this.raw;}setItem(_key:string,raw:string){this.raw=raw;}removeItem(){this.raw=null;}
}
// Synchronous SHA-256 binds draft request bodies to keys; it is not authentication.
const constants=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate=(value:number,bits:number)=>(value>>>bits)|(value<<(32-bits));
function sha256(text:string):string{
  const bytes=new TextEncoder().encode(text),padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);padded.set(bytes);padded[bytes.length]=0x80;
  const view=new DataView(padded.buffer);view.setUint32(padded.length-8,Math.floor(bytes.length/0x20000000));view.setUint32(padded.length-4,(bytes.length*8)>>>0);
  const state=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],words=new Uint32Array(64);
  for(let offset=0;offset<padded.length;offset+=64){
    for(let i=0;i<16;i++)words[i]=view.getUint32(offset+i*4);
    for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2],s0=rotate(a,7)^rotate(a,18)^(a>>>3),s1=rotate(b,17)^rotate(b,19)^(b>>>10);words[i]=(words[i-16]+s0+words[i-7]+s1)>>>0;}
    let [a,b,c,d,e,f,g,h]=state;
    for(let i=0;i<64;i++){
      const s1=rotate(e,6)^rotate(e,11)^rotate(e,25),choice=(e&f)^(~e&g),first=(h+s1+choice+constants[i]+words[i])>>>0;
      const s0=rotate(a,2)^rotate(a,13)^rotate(a,22),majority=(a&b)^(a&c)^(b&c),second=(s0+majority)>>>0;
      h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
    }
    for(const [i,value] of [a,b,c,d,e,f,g,h].entries())state[i]=(state[i]+value)>>>0;
  }
  return state.map(value=>value.toString(16).padStart(8,'0')).join('');
}
type Entry={key:string;raw:string;value:IntegrityRecoveryValue};
type Entries={status:'valid';entries:Entry[]}|{status:'invalid'|'unavailable'};

/** Independent slots keep unresolved requests when another page replaces the main cache. */
export class IntegrityRecoveryJournal{
  private storage?:IntegrityRecoveryStorage;private prefix?:string;
  constructor(private owner:string,private project:string,storage?:IntegrityRecoveryStorage){
    if(![owner,project].every(validId))return;
    try{this.prefix=`bb-integrity-recovery-journal-v1:${encodeURIComponent(owner)}:${encodeURIComponent(project)}:`;}catch{return;}
    try{this.storage=storage??globalThis.localStorage;}catch{/* Report inaccessible storage. */}
  }
  private cache(slot:Slot){return new IntegrityRecoveryCache(this.owner,this.project,slot);}
  private requestKey(value:IntegrityRecoveryValue):string|undefined{
    if(!this.prefix||!value.pending)return;const pending=value.pending;
    return pending.kind==='draft'?`${this.prefix}draft:${pending.request.expected_revision}:${sha256(JSON.stringify(pending.request))}`:
      `${this.prefix}${pending.kind}:${encodeURIComponent(pending.request.request_id)}`;
  }
  private normalized(value:IntegrityRecoveryValue):{status:'valid';value:IntegrityRecoveryValue;raw:string;key:string}|{status:'invalid'|'unavailable'}{
    if(!this.prefix)return {status:'invalid'};
    try{const slot=new Slot(),saved=this.cache(slot).save(value);if(saved.status!=='valid')return {status:saved.status==='unavailable'?'unavailable':'invalid'};
      const key=this.requestKey(saved.value);if(!key||slot.raw===null)return {status:'invalid'};return {status:'valid',value:saved.value,raw:slot.raw,key};
    }catch{return {status:'invalid'};}
  }
  private entry(key:string,raw:string):{status:'valid';entry:Entry}|{status:'invalid'|'unavailable'}{
    try{const saved=this.cache(new Slot(raw)).read();if(saved.status!=='valid')return {status:saved.status==='unavailable'?'unavailable':'invalid'};
      if(this.requestKey(saved.value)!==key)return {status:'invalid'};return {status:'valid',entry:{key,raw,value:saved.value}};
    }catch{return {status:'invalid'};}
  }
  private keys():string[]{
    const storage=this.storage!,length=storage.length;if(!Number.isSafeInteger(length)||length<0)throw Error('Invalid storage length');
    const all=new Set<string>(),keys:string[]=[];
    for(let i=0;i<length;i++){const key=storage.key(i);if(typeof key!=='string'||all.has(key))throw Error('Storage changed during enumeration');all.add(key);if(key.startsWith(this.prefix!))keys.push(key);}
    if(storage.length!==length)throw Error('Storage changed during enumeration');return keys.sort();
  }
  private entries():Entries{
    if(!this.prefix)return {status:'invalid'};if(!this.storage)return {status:'unavailable'};
    try{const keys=this.keys(),entries:Entry[]=[];
      for(const key of keys){const raw=this.storage.getItem(key);if(raw===null)return {status:'unavailable'};const saved=this.entry(key,raw);if(saved.status!=='valid')return saved;entries.push(saved.entry);}
      if(JSON.stringify(keys)!==JSON.stringify(this.keys())||entries.some(entry=>this.storage!.getItem(entry.key)!==entry.raw))return {status:'unavailable'};
      return {status:'valid',entries};
    }catch{return {status:'unavailable'};}
  }
  readAll():IntegrityRecoveryJournalRead{const saved=this.entries();if(saved.status!=='valid')return saved;const values=saved.entries.map(entry=>entry.value);Object.freeze(values);return {status:'valid',values};}
  // These observable comparisons are not an atomic cross-tab transaction. Server
  // revision and idempotency checks remain authoritative; reading never POSTs.
  retain(value:IntegrityRecoveryValue):IntegrityRecoveryJournalResult{
    const snapshot=this.normalized(value);if(snapshot.status!=='valid')return snapshot;const saved=this.entries();if(saved.status!=='valid')return saved;
    const previous=saved.entries.find(entry=>entry.key===snapshot.key);if(previous)return sameValue(previous.value,snapshot.value)?{status:'valid',value:previous.value}:{status:'conflict'};
    try{const raw=this.storage!.getItem(snapshot.key);
      if(raw!==null){const current=this.entry(snapshot.key,raw);return current.status==='valid'?(sameValue(current.entry.value,snapshot.value)?{status:'valid',value:current.entry.value}:{status:'conflict'}):current;}
      this.storage!.setItem(snapshot.key,snapshot.raw);if(this.storage!.getItem(snapshot.key)!==snapshot.raw)return {status:'unavailable'};
      const checked=this.entries();if(checked.status!=='valid')return checked;const entry=checked.entries.find(entry=>entry.key===snapshot.key);
      return entry&&sameValue(entry.value,snapshot.value)?{status:'valid',value:entry.value}:{status:'unavailable'};
    }catch{return {status:'unavailable'};}
  }
  // Call only after authoritative acknowledgement. A failed local cleanup must
  // remain a cleanup warning, not change an acknowledged request into "unknown".
  confirm(value:IntegrityRecoveryValue):IntegrityRecoveryJournalConfirm{
    const expected=this.normalized(value);if(expected.status!=='valid')return expected;if(!this.storage)return {status:'unavailable'};
    try{const raw=this.storage.getItem(expected.key);if(raw===null)return {status:'conflict'};const saved=this.entry(expected.key,raw);if(saved.status!=='valid')return saved;
      if(!sameValue(saved.entry.value,expected.value)||this.storage.getItem(expected.key)!==raw)return {status:'conflict'};
      this.storage.removeItem(expected.key);return this.storage.getItem(expected.key)===null?{status:'empty'}:{status:'unavailable'};
    }catch{return {status:'unavailable'};}
  }
}
