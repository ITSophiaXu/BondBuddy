import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ReviewDecision,ReviewExportRequest} from '@bondbuddy/contracts';
import {ReviewEditorCache,type ReviewEditorCacheValue,type ReviewEditorCacheStorage} from './review-editor-cache.js';

class MemoryStorage implements ReviewEditorCacheStorage{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const sha='a'.repeat(64),otherSha='b'.repeat(64),issueIds=['issue-1','issue-2'],key='bb-review-editor:owner:project:run';
const decisions=():ReviewDecision[]=>[{id:'issue-1',decision:'manual',manual_text:'人工确认的新文本'},{id:'issue-2',decision:'original',manual_text:''}];
const pending=():ReviewExportRequest=>({request_id:'same-retry-request',source_run_id:'run',expected_editor_sha256:sha,decisions:decisions()});
const value=():ReviewEditorCacheValue=>({sha256:sha,decisions:decisions(),pending:pending()});
const wrapper=(saved:unknown)=>({version:'review-editor-cache-v1',owner:'owner',project:'project',run:'run',value:saved});

test('review editor cache restores the complete export envelope as deeply frozen independent copies',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage),input=value();
  assert.deepEqual(cache.read(sha,issueIds),{status:'empty'});assert.equal(cache.save(input,issueIds),true);
  const restored=cache.read(sha,issueIds);assert.equal(restored.status,'valid');if(restored.status!=='valid')return;
  assert.deepEqual(restored.value,input);assert.equal(Object.isFrozen(restored.value),true);assert.equal(Object.isFrozen(restored.value.decisions),true);
  assert.equal(Object.isFrozen(restored.value.decisions[0]),true);assert.equal(Object.isFrozen(restored.value.pending),true);
  assert.equal(Object.isFrozen(restored.value.pending!.decisions),true);assert.equal(Object.isFrozen(restored.value.pending!.decisions[0]),true);
  input.decisions[0].manual_text='外部输入变化';input.pending!.request_id='new-request';
  assert.equal(restored.value.decisions[0].manual_text,'人工确认的新文本');assert.equal(restored.value.pending!.request_id,'same-retry-request');
  assert.equal(Reflect.set(restored.value.pending!,'request_id','tampered'),false);
  const again=cache.read(sha,issueIds);assert.equal(again.status,'valid');if(again.status==='valid'){
    assert.notEqual(again.value,restored.value);assert.notEqual(again.value.decisions[0],restored.value.decisions[0]);
    assert.notEqual(again.value.pending!.decisions,restored.value.pending!.decisions);
  }
  assert.deepEqual(JSON.parse(storage.values.get(key)!),wrapper(value()));
});

test('review editor cache reads legacy values and migrates the identical pending request id on explicit save',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage),old=JSON.stringify(value());
  storage.values.set(key,old);const restored=cache.read(sha,issueIds);
  assert.equal(restored.status,'valid');assert.equal(storage.values.get(key),old);
  if(restored.status!=='valid')return;
  assert.equal(restored.value.pending!.request_id,'same-retry-request');assert.equal(cache.save(restored.value,issueIds),true);
  assert.deepEqual(JSON.parse(storage.values.get(key)!),wrapper(value()));
  assert.equal(cache.read(sha,issueIds).status,'valid');
});

test('review editor cache isolates owner, API project and source run identities',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage);cache.save(value(),issueIds);
  const raw=storage.values.get(key)!;
  for(const [owner,project,run] of [['other-owner','project','run'],['owner','other-project','run'],['owner','project','other-run']]){
    const other=new ReviewEditorCache(owner,project,run,storage);
    assert.equal(other.read(sha,issueIds).status,'empty');
    storage.values.set(`bb-review-editor:${owner}:${project}:${run}`,raw);
    assert.equal(other.read(sha,issueIds).status,'invalid');assert.equal(storage.values.get(key),raw);
  }
});

test('review editor cache refuses ambiguous legacy key identities but verifies wrapped colon IDs',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner:a','project','run',storage),collision=new ReviewEditorCache('owner','a:project','run',storage),colonKey='bb-review-editor:owner:a:project:run';
  storage.values.set(colonKey,JSON.stringify(value()));assert.equal(cache.read(sha,issueIds).status,'invalid');
  assert.equal(cache.save(value(),issueIds),true);assert.equal(cache.read(sha,issueIds).status,'valid');assert.equal(collision.read(sha,issueIds).status,'invalid');
});

test('review editor cache accepts complete empty issue sets and optional pending omission',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage);
  const empty={sha256:sha,decisions:[],pending:{...pending(),decisions:[]}};
  assert.equal(cache.save(empty,[]),true);assert.deepEqual(cache.read(sha,[]),{status:'valid',value:empty});
  assert.equal(cache.save({sha256:sha,decisions:decisions(),pending:undefined},issueIds),true);
  assert.deepEqual(cache.read(sha,issueIds),{status:'valid',value:{sha256:sha,decisions:decisions()}});
});

test('review editor cache requires the exact complete unique issue set',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage);
  for(const ids of [['issue-1'],['issue-1','issue-1'],['issue-1','unknown'],['issue-1',''],['issue-1','issue\n2'],Array(2001).fill('issue')]){
    assert.equal(cache.save(value(),ids),false);storage.values.set(key,JSON.stringify(value()));assert.equal(cache.read(sha,ids).status,'invalid');
  }
  const reversed={sha256:sha,decisions:decisions().reverse()};assert.equal(cache.save(reversed,issueIds),true);assert.deepEqual(cache.read(sha,issueIds),{status:'valid',value:reversed});
});

test('review editor cache rejects malformed schema or mismatched frozen envelopes without clearing storage',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage),base=value();
  const malformed:unknown[]=[null,[],{},
    {...base,extra:true},{...base,sha256:'bad'},{...base,sha256:sha.toUpperCase()},
    {...base,decisions:[decisions()[0]]},{...base,decisions:[decisions()[0],decisions()[0]]},
    {...base,decisions:[{...decisions()[0],decision:'unknown'},decisions()[1]]},
    {...base,decisions:[{...decisions()[0],manual_text:9},decisions()[1]]},
    {...base,decisions:[{...decisions()[0],manual_text:'x'.repeat(12001)},decisions()[1]]},
    {...base,decisions:[{...decisions()[0],extra:true},decisions()[1]]},
    {...base,decisions:[{...decisions()[0],id:'bad\nid'},decisions()[1]]},
    {...base,pending:null},{...base,pending:{...pending(),extra:true}},
    {...base,pending:{...pending(),request_id:''}},{...base,pending:{...pending(),request_id:'request\nid'}},
    {...base,pending:{...pending(),source_run_id:'other-run'}},{...base,pending:{...pending(),expected_editor_sha256:otherSha}},
    {...base,pending:{...pending(),decisions:decisions().reverse()}},
    {...base,pending:{...pending(),decisions:[{...decisions()[0],manual_text:'different'},decisions()[1]]}},
    {...base,pending:{...pending(),decisions:[decisions()[0],decisions()[0]]}},
  ];
  for(const saved of malformed){
    assert.equal(cache.save(saved as ReviewEditorCacheValue,issueIds),false);
    const raw=JSON.stringify(wrapper(saved));storage.values.set(key,raw);assert.equal(cache.read(sha,issueIds).status,'invalid');assert.equal(storage.values.get(key),raw);
  }
  storage.values.set(key,JSON.stringify(wrapper(base)));assert.equal(cache.read(otherSha,issueIds).status,'invalid');
});

test('review editor cache rejects unknown wrapper fields, versions and namespace attribution',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage),base=wrapper(value());
  for(const bad of [{...base,version:'unknown'},{...base,owner:'other-owner'},{...base,project:'navigation-project'},{...base,run:'different-run'},{...base,extra:true},{version:base.version,owner:base.owner,project:base.project,value:base.value}]){
    const raw=JSON.stringify(bad);storage.values.set(key,raw);assert.equal(cache.read(sha,issueIds).status,'invalid');assert.equal(storage.values.get(key),raw);
  }
});

test('review editor cache verifies writes even when storage silently loses or changes data',()=>{
  const lost:ReviewEditorCacheStorage={getItem:()=>null,setItem(){},removeItem(){}};
  assert.equal(new ReviewEditorCache('owner','project','run',lost).save(value(),issueIds),false);
  const storage=new MemoryStorage();storage.values.set(key,JSON.stringify(wrapper({...value(),pending:{...pending(),request_id:'older-id'}})));
  const ignored:ReviewEditorCacheStorage={getItem:k=>storage.getItem(k),setItem(){},removeItem:k=>storage.removeItem(k)};
  assert.equal(new ReviewEditorCache('owner','project','run',ignored).save(value(),issueIds),false);
  storage.values.set(key,JSON.stringify(value()));
  assert.equal(new ReviewEditorCache('owner','project','run',ignored).save(value(),issueIds),false);
  const altered:ReviewEditorCacheStorage={getItem:k=>storage.getItem(k),setItem(k,raw){const parsed=JSON.parse(raw);parsed.value.decisions[0].manual_text='altered';storage.setItem(k,JSON.stringify(parsed));},removeItem:k=>storage.removeItem(k)};
  assert.equal(new ReviewEditorCache('owner','project','run',altered).save(value(),issueIds),false);
});

test('review editor cache returns unavailable for storage exceptions and refuses invalid namespace ids',()=>{
  const broken:ReviewEditorCacheStorage={getItem(){throw Error('read denied');},setItem(){throw Error('quota');},removeItem(){throw Error('remove denied');}},cache=new ReviewEditorCache('owner','project','run',broken);
  assert.deepEqual(cache.read(sha,issueIds),{status:'unavailable'});assert.equal(cache.save(value(),issueIds),false);assert.equal(cache.clear(),false);
  const storage=new MemoryStorage();
  for(const invalid of ['', '  ','bad\nid','bad\u007fid','bad\u0085id','x'.repeat(129)])for(const where of [0,1,2]){
    const ids=['owner','project','run'];ids[where]=invalid;const invalidCache=new ReviewEditorCache(ids[0],ids[1],ids[2],storage);
    assert.equal(invalidCache.read(sha,issueIds).status,'invalid');assert.equal(invalidCache.save(value(),issueIds),false);assert.equal(invalidCache.clear(),false);
  }
});

test('review editor cache tolerates malformed JSON and verifies successful clearing',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage);
  for(const raw of ['{broken','null','[]','"unexpected"']){storage.values.set(key,raw);assert.equal(cache.read(sha,issueIds).status,'invalid');assert.equal(storage.values.get(key),raw);}
  assert.equal(cache.clear(),true);assert.equal(cache.read(sha,issueIds).status,'empty');
  const ignored:ReviewEditorCacheStorage={getItem:()=>'{still present}',setItem(){},removeItem(){}};
  assert.equal(new ReviewEditorCache('owner','project','run',ignored).clear(),false);
});

test('review editor cache supports contract text and issue count boundaries',()=>{
  const storage=new MemoryStorage(),cache=new ReviewEditorCache('owner','project','run',storage),full=Array.from({length:2000},(_,i)=>({id:`issue-${i}`,decision:'manual' as const,manual_text:i===0?'\u0000'.repeat(12000):''}));
  const input={sha256:sha,decisions:full,pending:{...pending(),decisions:full}};
  assert.equal(cache.save(input,full.map(d=>d.id)),true);assert.deepEqual(cache.read(sha,full.map(d=>d.id)),{status:'valid',value:input});
});

test('review editor cache uses local storage and handles a blocked storage getter',()=>{
  const storage=new MemoryStorage(),local=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),session=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  try{
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage});
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get:()=>{throw Error('must not use session storage');}});
    const cache=new ReviewEditorCache('owner','project','run');assert.equal(cache.save(value(),issueIds),true);assert.equal(cache.read(sha,issueIds).status,'valid');
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw Error('blocked');}});
    const blocked=new ReviewEditorCache('owner','project','run');assert.equal(blocked.read(sha,issueIds).status,'unavailable');assert.equal(blocked.save(value(),issueIds),false);assert.equal(blocked.clear(),false);
  }finally{
    if(local)Object.defineProperty(globalThis,'localStorage',local);else Reflect.deleteProperty(globalThis,'localStorage');
    if(session)Object.defineProperty(globalThis,'sessionStorage',session);else Reflect.deleteProperty(globalThis,'sessionStorage');
  }
});
