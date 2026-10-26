import {QaRecoveryCache,type QaRecoveryCacheStorage,type QaRecoveryValue} from './qa-recovery-cache.js';

export type QaRecoveryJournalStorage=Pick<Storage,'length'|'key'|'getItem'|'setItem'|'removeItem'>;
export type QaRecoveryJournalRead={status:'valid';values:QaRecoveryValue[]}|{status:'invalid'|'unavailable';values?:undefined};
export type QaRecoveryJournalResult={status:'valid';value:QaRecoveryValue}|{status:'invalid'|'unavailable'|'conflict';value?:undefined};
export type QaRecoveryJournalConfirm={status:'empty'|'invalid'|'unavailable'|'conflict'};
type Entry={key:string;raw:string;value:QaRecoveryValue};
type Entries={status:'valid';entries:Entry[]}|{status:'invalid'|'unavailable'};
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);

class Slot implements QaRecoveryCacheStorage{
  constructor(public raw:string|null=null){}
  getItem(){return this.raw;}
  setItem(_key:string,raw:string){this.raw=raw;}
  removeItem(){this.raw=null;}
}
// Synchronous SHA-256 permits readAll() to verify draft key/body binding without
// asynchronous browser crypto. This is a storage identity, not authentication.
const constants=[
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
const rotate=(value:number,bits:number)=>(value>>>bits)|(value<<(32-bits));
export function qaRecoveryDigest(text:string):string{
  const bytes=new TextEncoder().encode(text),padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);padded.set(bytes);padded[bytes.length]=0x80;
  const view=new DataView(padded.buffer);view.setUint32(padded.length-8,Math.floor(bytes.length/0x20000000));view.setUint32(padded.length-4,(bytes.length*8)>>>0);
  const state=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],words=new Uint32Array(64);
  for(let offset=0;offset<padded.length;offset+=64){
    for(let i=0;i<16;i++)words[i]=view.getUint32(offset+i*4);
    for(let i=16;i<64;i++){
      const a=words[i-15],b=words[i-2],s0=rotate(a,7)^rotate(a,18)^(a>>>3),s1=rotate(b,17)^rotate(b,19)^(b>>>10);
      words[i]=(words[i-16]+s0+words[i-7]+s1)>>>0;
    }
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
const sameValue=(a:QaRecoveryValue,b:QaRecoveryValue)=>JSON.stringify(a)===JSON.stringify(b);

/** Each pending request has its own durable slot; reading never submits it. */
export class QaRecoveryJournal{
  private storage?:QaRecoveryJournalStorage;
  private prefix?:string;
  constructor(private owner:string,private project:string,storage?:QaRecoveryJournalStorage){
    if(![owner,project].every(validId))return;
    try{this.prefix=`bb-qa-recovery-journal-v1:${encodeURIComponent(owner)}:${encodeURIComponent(project)}:`;}catch{return;}
    try{this.storage=storage??globalThis.localStorage;}catch{/* Access is reported as unavailable. */}
  }
  private cache(slot:Slot){return new QaRecoveryCache(this.owner,this.project,slot);}
  private requestKey(value:QaRecoveryValue):string|undefined{
    if(!this.prefix||!value.pending)return;
    const pending=value.pending;
    // Cache save/read canonicalizes every nested field and preserves array order.
    return pending.kind==='draft'?`${this.prefix}draft:${pending.request.expected_revision}:${qaRecoveryDigest(JSON.stringify(pending.request))}`:
      `${this.prefix}${pending.kind}:${encodeURIComponent(pending.request.request_id)}`;
  }
  private normalized(value:QaRecoveryValue):{status:'valid';value:QaRecoveryValue;raw:string;key:string}|{status:'invalid'|'unavailable'}{
    if(!this.prefix)return {status:'invalid'};
    try{
      const slot=new Slot(),saved=this.cache(slot).save(value);
      if(saved.status!=='valid')return {status:saved.status==='unavailable'?'unavailable':'invalid'};
      const key=this.requestKey(saved.value);if(!key||slot.raw===null)return {status:'invalid'};
      return {status:'valid',value:saved.value,raw:slot.raw,key};
    }catch{return {status:'invalid'};}
  }
  private entry(key:string,raw:string):{status:'valid';entry:Entry}|{status:'invalid'|'unavailable'}{
    try{
      const saved=this.cache(new Slot(raw)).read();
      if(saved.status!=='valid')return {status:saved.status==='unavailable'?'unavailable':'invalid'};
      if(this.requestKey(saved.value)!==key)return {status:'invalid'};
      return {status:'valid',entry:{key,raw,value:saved.value}};
    }catch{return {status:'invalid'};}
  }
  private keys():string[]{
    const storage=this.storage!,length=storage.length;
    if(!Number.isSafeInteger(length)||length<0)throw Error('Invalid storage length');
    const all=new Set<string>(),keys:string[]=[];
    for(let i=0;i<length;i++){
      const key=storage.key(i);if(typeof key!=='string'||all.has(key))throw Error('Storage changed during enumeration');all.add(key);
      if(key.startsWith(this.prefix!))keys.push(key);
    }
    if(storage.length!==length)throw Error('Storage changed during enumeration');
    return keys.sort();
  }
  private entries():Entries{
    if(!this.prefix)return {status:'invalid'};
    if(!this.storage)return {status:'unavailable'};
    try{
      const keys=this.keys(),entries:Entry[]=[];
      for(const key of keys){
        const raw=this.storage.getItem(key);if(raw===null)return {status:'unavailable'};
        const saved=this.entry(key,raw);if(saved.status!=='valid')return saved;entries.push(saved.entry);
      }
      if(JSON.stringify(keys)!==JSON.stringify(this.keys())||entries.some(entry=>this.storage!.getItem(entry.key)!==entry.raw))return {status:'unavailable'};
      return {status:'valid',entries};
    }catch{return {status:'unavailable'};}
  }
  readAll():QaRecoveryJournalRead{
    const saved=this.entries();if(saved.status!=='valid')return saved;
    const values=saved.entries.map(entry=>entry.value);Object.freeze(values);return {status:'valid',values};
  }
  // These guards are not atomic cross-tab CAS. Independent keys prevent different
  // requests overwriting each other; API CAS/idempotency remain authoritative.
  retain(value:QaRecoveryValue):QaRecoveryJournalResult{
    const snapshot=this.normalized(value);if(snapshot.status!=='valid')return snapshot;
    const saved=this.entries();if(saved.status!=='valid')return saved;
    const previous=saved.entries.find(entry=>entry.key===snapshot.key);
    if(previous)return sameValue(previous.value,snapshot.value)?{status:'valid',value:previous.value}:{status:'conflict'};
    try{
      // Recheck this identity immediately before writing; do not replace a record
      // another page added while the namespace was being read.
      const raw=this.storage!.getItem(snapshot.key);
      if(raw!==null){const current=this.entry(snapshot.key,raw);return current.status==='valid'?(sameValue(current.entry.value,snapshot.value)?
        {status:'valid',value:current.entry.value}:{status:'conflict'}):current;}
      this.storage!.setItem(snapshot.key,snapshot.raw);
      if(this.storage!.getItem(snapshot.key)!==snapshot.raw)return {status:'unavailable'};
      const checked=this.entries();if(checked.status!=='valid')return checked;
      const entry=checked.entries.find(entry=>entry.key===snapshot.key);
      return entry&&sameValue(entry.value,snapshot.value)?{status:'valid',value:entry.value}:{status:'unavailable'};
    }catch{return {status:'unavailable'};}
  }
  confirm(value:QaRecoveryValue):QaRecoveryJournalConfirm{
    const expected=this.normalized(value);if(expected.status!=='valid')return expected;
    if(!this.storage)return {status:'unavailable'};
    try{
      const raw=this.storage.getItem(expected.key);if(raw===null)return {status:'conflict'};
      const saved=this.entry(expected.key,raw);if(saved.status!=='valid')return saved;
      if(!sameValue(saved.entry.value,expected.value)||this.storage.getItem(expected.key)!==raw)return {status:'conflict'};
      this.storage.removeItem(expected.key);
      return this.storage.getItem(expected.key)===null?{status:'empty'}:{status:'unavailable'};
    }catch{return {status:'unavailable'};}
  }
}
