import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ReviewDecision,ReviewEditorExecution,ReviewExportRequest} from '@bondbuddy/contracts';
import {ReviewEditorCache,type ReviewEditorCacheStorage,type ReviewEditorCacheValue} from './review-editor-cache.js';

// All identities and text in this file are synthetic.
class MemoryStorage implements ReviewEditorCacheStorage{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const sha='a'.repeat(64),issueIds=['synthetic-issue'],key='bb-review-editor:synthetic-owner:synthetic-project:synthetic-run';
const execution=():ReviewEditorExecution=>({execution_version:1,input_revision:7,input_hash:'b'.repeat(64)});
const decisions=():ReviewDecision[]=>[{id:issueIds[0],decision:'manual',manual_text:'Synthetic manual correction.'}];
const legacyPending=():ReviewExportRequest=>({request_id:'synthetic-original-request',source_run_id:'synthetic-run',expected_editor_sha256:sha,decisions:decisions()});
const pending=():ReviewExportRequest=>({request_id:'synthetic-pinned-request',source_run_id:'synthetic-run',expected_editor_sha256:sha,source_execution:execution(),decisions:decisions()});
const value=(withPending=true):ReviewEditorCacheValue=>({sha256:sha,decisions:decisions(),...(withPending?{pending:pending()}:{})});
const wrapper=(saved:unknown,pin?:unknown)=>({version:'review-editor-cache-v1',owner:'synthetic-owner',project:'synthetic-project',run:'synthetic-run',...(pin!==undefined?{execution:pin}:{}),value:saved});
const cache=(storage:ReviewEditorCacheStorage,pin?:ReviewEditorExecution)=>new ReviewEditorCache('synthetic-owner','synthetic-project','synthetic-run',storage,pin);
function restored(reader:ReviewEditorCache){
  const result=reader.read(sha,issueIds);assert.equal(result.status,'valid');
  if(result.status!=='valid')throw new Error('Expected a valid synthetic recovery record.');
  return result.value;
}

test('same editor bytes do not share ordinary choices across any execution identity field',()=>{
  const storage=new MemoryStorage(),saved=value(false),writer=cache(storage,execution());
  assert.equal(writer.save(saved,issueIds),true);
  const raw=storage.getItem(key)!;
  assert.deepEqual(JSON.parse(raw),wrapper(saved,execution()));
  const mismatches=[{...execution(),execution_version:2},{...execution(),input_revision:8},{...execution(),input_hash:'c'.repeat(64)}];
  for(const pin of mismatches){
    assert.equal(cache(storage,pin).read(sha,issueIds).status,'invalid');
    assert.equal(storage.getItem(key),raw,'a different execution must preserve the unresolved recovery record');
  }
  assert.equal(cache(storage).read(sha,issueIds).status,'invalid','an omitted response pin cannot verify a pinned wrapper');
  assert.deepEqual(restored(writer),saved);
});

test('complete source execution pins survive serialization as independent deeply frozen copies',()=>{
  const storage=new MemoryStorage(),expected=execution(),writer=cache(storage,expected),input=value();
  const before=JSON.stringify(input.pending);
  assert.equal(writer.save(input,issueIds),true);
  expected.input_revision=99;
  const saved=restored(writer),pin=saved.pending!.source_execution!;
  assert.equal(JSON.stringify(saved.pending),before);
  assert.deepEqual(pin,execution());
  assert.notEqual(pin,input.pending!.source_execution);
  assert.equal(Object.isFrozen(saved),true);assert.equal(Object.isFrozen(saved.pending),true);
  assert.equal(Object.isFrozen(pin),true);assert.equal(Reflect.set(pin,'input_hash','d'.repeat(64)),false);
  input.pending!.source_execution!.input_hash='e'.repeat(64);input.pending!.request_id='synthetic-mutated-request';
  assert.deepEqual(pin,execution());assert.equal(JSON.stringify(saved.pending),before);
  const again=restored(writer);
  assert.equal(JSON.stringify(again.pending),before);
  assert.notEqual(again.pending!.source_execution,pin);
  assert.deepEqual(JSON.parse(storage.getItem(key)!).execution,execution());
});

test('legacy raw and wrapped choices and pending envelopes recover only under original V1 semantics',()=>{
  for(const withPending of [false,true])for(const wrapped of [false,true]){
    const storage=new MemoryStorage(),saved={sha256:sha,decisions:decisions(),...(withPending?{pending:legacyPending()}:{})};
    const raw=JSON.stringify(wrapped?wrapper(saved):saved);storage.setItem(key,raw);
    for(const pin of [undefined,execution()]){
      assert.deepEqual(restored(cache(storage,pin)),saved);
      assert.equal(storage.getItem(key),raw,'reading never migrates or submits an old recovery record');
    }
    assert.equal(cache(storage,{...execution(),execution_version:2}).read(sha,issueIds).status,'invalid');
    assert.equal(storage.getItem(key),raw);
  }
});

test('explicitly saving a recovered old pending envelope pins only its wrapper and preserves its retry body',()=>{
  for(const wrapped of [false,true]){
    const storage=new MemoryStorage(),saved={sha256:sha,decisions:decisions(),pending:legacyPending()},before=JSON.stringify(saved.pending);
    const raw=JSON.stringify(wrapped?wrapper(saved):saved);storage.setItem(key,raw);
    const writer=cache(storage,execution()),old=restored(writer);
    assert.equal(Object.hasOwn(old.pending!,'source_execution'),false);
    assert.equal(JSON.stringify(old.pending),before);assert.equal(storage.getItem(key),raw);
    assert.equal(writer.save(old,issueIds),true);
    const migrated=JSON.parse(storage.getItem(key)!);
    assert.deepEqual(migrated.execution,execution());
    assert.equal(Object.hasOwn(migrated.value.pending,'source_execution'),false);
    assert.equal(JSON.stringify(migrated.value.pending),before);
    assert.equal(JSON.stringify(restored(writer).pending),before);
    assert.equal(restored(writer).pending!.request_id,'synthetic-original-request');
  }
});

test('a matching wrapper cannot make an unpinned old pending envelope valid for a later execution',()=>{
  const storage=new MemoryStorage(),later={...execution(),execution_version:2},reader=cache(storage,later);
  const saved={sha256:sha,decisions:decisions(),pending:legacyPending()};
  assert.equal(reader.save(saved,issueIds),false);assert.equal(storage.getItem(key),null);
  const raw=JSON.stringify(wrapper(saved,later));storage.setItem(key,raw);
  assert.equal(reader.read(sha,issueIds).status,'invalid');assert.equal(storage.getItem(key),raw);
});

test('source execution must be complete, strict and equal to the current execution even inside a matching wrapper',()=>{
  const badPins:unknown[]=[
    {...execution(),execution_version:2},{...execution(),input_revision:8},{...execution(),input_hash:'c'.repeat(64)},
    {execution_version:1},{execution_version:1,input_revision:7},
    {...execution(),input_revision:0},{...execution(),input_revision:2147483648},
    {...execution(),execution_version:1.5},{...execution(),input_hash:'B'.repeat(64)},
    {...execution(),active:true},null,
  ];
  for(const pin of badPins){
    const storage=new MemoryStorage(),reader=cache(storage,execution());
    const saved={...value(),pending:{...pending(),source_execution:pin}} as ReviewEditorCacheValue;
    assert.equal(reader.save(saved,issueIds),false);assert.equal(storage.getItem(key),null);
    const raw=JSON.stringify(wrapper(saved,execution()));storage.setItem(key,raw);
    assert.equal(reader.read(sha,issueIds).status,'invalid');assert.equal(storage.getItem(key),raw);
  }
});

test('malformed wrapper execution and invalid expected identities never authorize recovery or a write',()=>{
  const badPins:unknown[]=[{execution_version:1},null,{...execution(),input_hash:'bad'},
    {...execution(),execution_version:0},{...execution(),execution_version:2147483648},
    {...execution(),input_revision:1.5},{...execution(),extra:'synthetic'}];
  for(const pin of badPins){
    const storage=new MemoryStorage(),raw=JSON.stringify(wrapper(value(false),pin));storage.setItem(key,raw);
    assert.equal(cache(storage,execution()).read(sha,issueIds).status,'invalid');
    assert.equal(storage.getItem(key),raw);
    const invalidExpected=cache(storage,pin as ReviewEditorExecution);
    assert.equal(invalidExpected.read(sha,issueIds).status,'invalid');
    assert.equal(invalidExpected.save(value(false),issueIds),false);assert.equal(storage.getItem(key),raw);
  }
});
