import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PROJECT_DOCUMENT_CATALOG,OUTCOME_PRICE_VERSION} from '@bondbuddy/contracts';
import {FileGenerationCache,type FileGenerationBatchRequest,type FileGenerationCacheStorage,type FileGenerationNoteOperation} from './file-generation-cache.js';

class MemoryStorage implements FileGenerationCacheStorage{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const request=():FileGenerationBatchRequest=>({request_id:'request-1',source_version_id:'source-v3',expected_selection_revision:7,documents:[{document_type:'issuer',draft_version:2},{document_type:'financial',draft_version:4}]});
test('ordinary upgrade reads a priced numeric file batch without replacing the original request',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage),key='bondbuddy:file-generation:owner:project:pending';
  const legacy={...request(),expected_points:5000,price_version:OUTCOME_PRICE_VERSION};
  const raw=JSON.stringify({version:'file-generation-cache-v1',owner:'owner',project:'project',value:legacy});storage.setItem(key,raw);
  assert.equal(cache.readForEntry().status,'ok');assert.deepEqual(cache.readPending(),legacy);assert.equal(storage.getItem(key),raw);
  assert.equal(new FileGenerationCache('other','project',storage).readPending(),undefined);
});
const operation=():FileGenerationNoteOperation=>({note:'本轮追加要求',documents:[
  {document_type:'issuer',before:'发行人原有要求',after:'发行人原有要求\n\n本轮追加要求'},
  {document_type:'financial',before:'财务原有要求',after:'财务原有要求\n\n本轮追加要求'},
]});
function replace(storage:MemoryStorage,kind:string,change:(record:Record<string,unknown>)=>unknown){
  const key=[...storage.values.keys()].find(key=>key.endsWith(':'+kind))!;
  storage.values.set(key,JSON.stringify(change(JSON.parse(storage.values.get(key)!))));
}

test('file generation cache distinguishes an explicit empty selection from no saved selection',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage);
  assert.equal(cache.readSelection(),undefined);
  assert.equal(cache.saveSelection(['issuer','financial']),true);assert.deepEqual(cache.readSelection(),['issuer','financial']);
  assert.equal(cache.saveSelection([]),true);assert.deepEqual(cache.readSelection(),[]);
  assert.equal(cache.clearSelection(),true);assert.equal(cache.readSelection(),undefined);
});

test('file generation cache separates owners and resource projects without key collisions',()=>{
  const storage=new MemoryStorage(),a=new FileGenerationCache('owner:a','project',storage),otherOwner=new FileGenerationCache('owner','a:project',storage),otherProject=new FileGenerationCache('owner:a','other-project',storage);
  a.saveSelection(['issuer']);a.savePending(request());a.saveNote('本项目要求');
  for(const cache of [otherOwner,otherProject]){assert.equal(cache.readSelection(),undefined);assert.equal(cache.readPending(),undefined);assert.equal(cache.readNote(),undefined);}
  otherOwner.saveSelection([]);assert.deepEqual(a.readSelection(),['issuer']);assert.deepEqual(otherOwner.readSelection(),[]);
});

test('file generation cache retains the complete retry envelope and returns frozen copies',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage),pending=request();
  assert.equal(cache.savePending(pending),true);const restored=cache.readPending()!;assert.deepEqual(restored,pending);
  assert.equal(Object.isFrozen(restored),true);assert.equal(Object.isFrozen(restored.documents),true);assert.equal(Object.isFrozen(restored.documents[0]),true);
  assert.notEqual(cache.readPending(),restored);assert.notEqual(cache.readPending()!.documents,restored.documents);
  cache.saveSelection(['issuer']);cache.saveNote('保留要求');assert.equal(cache.clearPending(),true);assert.equal(cache.readPending(),undefined);assert.deepEqual(cache.readSelection(),['issuer']);assert.equal(cache.readNote(),'保留要求');
});

test('file generation cache rejects unsupported or duplicate document selections',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage);
  for(const selection of [['issuer','issuer'],['unknown'],[1],null])assert.equal(cache.saveSelection(selection as never),false);
  cache.saveSelection(['issuer']);replace(storage,'selection',record=>({...record,value:['issuer','issuer']}));assert.equal(cache.readSelection(),undefined);
  cache.saveSelection(['issuer']);replace(storage,'selection',record=>({...record,value:['unknown']}));assert.equal(cache.readSelection(),undefined);
});

test('file generation cache rejects incomplete envelopes, unknown fields and invalid versions',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage),base=request();
  const invalid:unknown[]=[{...base,source_version_id:undefined},{...base,extra:true},{...base,request_id:''},{...base,request_id:'unsafe\nrequest'},{...base,expected_selection_revision:-1},{...base,expected_selection_revision:0.5},{...base,expected_selection_revision:Number.MAX_SAFE_INTEGER+1},{...base,documents:[]},{...base,documents:[{document_type:'issuer',draft_version:0}]},{...base,documents:[{document_type:'issuer',draft_version:1.5}]},{...base,documents:[{document_type:'issuer',draft_version:1,extra:true}]},{...base,documents:[{document_type:'unknown',draft_version:1}]},{...base,documents:[{document_type:'issuer',draft_version:1},{document_type:'issuer',draft_version:2}]}];
  for(const value of invalid){assert.equal(cache.savePending(value as FileGenerationBatchRequest),false);cache.savePending(base);replace(storage,'pending',record=>({...record,value}));assert.equal(cache.readPending(),undefined);}
});

test('file generation cache verifies its storage wrapper instead of trusting the key',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage);
  for(const change of [(r:Record<string,unknown>)=>({...r,owner:'another-owner'}),(r:Record<string,unknown>)=>({...r,project:'another-project'}),(r:Record<string,unknown>)=>({...r,version:'unknown'}),(r:Record<string,unknown>)=>({...r,unknown:true}),(r:Record<string,unknown>)=>({version:r.version,owner:r.owner,project:r.project})]){
    cache.savePending(request());replace(storage,'pending',change);assert.equal(cache.readPending(),undefined);
  }
});

test('file generation cache preserves empty notes and enforces the common-requirements limit',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage);
  assert.equal(cache.readNote(),undefined);assert.equal(cache.saveNote(''),true);assert.equal(cache.readNote(),'');
  assert.equal(cache.saveNote('本轮要求\n保留人工确认标记'),true);assert.equal(cache.readNote(),'本轮要求\n保留人工确认标记');
  assert.equal(cache.saveNote('x'.repeat(12000)),true);assert.equal(cache.readNote()?.length,12000);
  assert.equal(cache.saveNote('x'.repeat(12001)),false);assert.equal(cache.saveNote(null as never),false);
  replace(storage,'note',record=>({...record,value:9}));assert.equal(cache.readNote(),undefined);
  cache.saveNote('saved');replace(storage,'note',record=>({...record,value:'x'.repeat(12001)}));assert.equal(cache.readNote(),undefined);
  assert.equal(cache.clearNote(),true);assert.equal(cache.readNote(),undefined);
});

test('file generation note operation keeps its original scope and before/after values as frozen copies',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','api-project',storage);
  const input={note:'追加要求',documents:[{document_type:'issuer' as const,before:'原要求',after:'原要求\n\n追加要求'}]};
  assert.equal(cache.readNoteOperation(),undefined);assert.equal(cache.saveNoteOperation(input),true);
  const restored=cache.readNoteOperation()!;
  assert.deepEqual(restored,input);assert.equal(Object.isFrozen(restored),true);
  assert.equal(Object.isFrozen(restored.documents),true);assert.equal(Object.isFrozen(restored.documents[0]),true);
  input.note='其他要求';input.documents[0].after='写入后外部改动';input.documents.push({document_type:'issuer',before:'x',after:'y'});
  assert.equal(restored.note,'追加要求');assert.equal(restored.documents.length,1);assert.equal(restored.documents[0].after,'原要求\n\n追加要求');
  assert.equal(Reflect.set(restored,'note','tampered'),false);assert.equal(Reflect.set(restored.documents[0],'after','tampered'),false);
  const second=cache.readNoteOperation()!;assert.deepEqual(second,restored);assert.notEqual(second,restored);
  assert.notEqual(second.documents,restored.documents);assert.notEqual(second.documents[0],restored.documents[0]);
  assert.ok([...storage.values.keys()].some(key=>key==='bondbuddy:file-generation:owner:api-project:note-operation'));
  cache.saveSelection(['financial']);cache.savePending(request());cache.saveNote('尚未开始的草稿');
  assert.equal(cache.clearNoteOperation(),true);assert.equal(cache.readNoteOperation(),undefined);
  assert.deepEqual(cache.readSelection(),['financial']);assert.deepEqual(cache.readPending(),request());assert.equal(cache.readNote(),'尚未开始的草稿');
});

test('file generation note operation rejects malformed, widened or duplicate recovery scope on save and read',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','api-project',storage),base=operation(),document=base.documents[0];
  const invalid:unknown[]=[null,[],{},
    {...base,extra:true},{documents:base.documents},{...base,note:null},{...base,note:9},{...base,note:''},{...base,note:' \n\t '},{...base,note:'x'.repeat(12001)},
    {...base,documents:null},{...base,documents:{}},{...base,documents:[]},{...base,documents:Array(13).fill(document)},
    {...base,documents:[document,{...document,after:'另一份重复类型'}]},
    {...base,documents:[{...document,document_type:'unknown'}]},{...base,documents:[{...document,document_type:1}]},
    {...base,documents:[{...document,extra:true}]},{...base,documents:[{document_type:'issuer',after:'新值'}]},
    {...base,documents:[{document_type:'issuer',before:'旧值'}]},{...base,documents:[{...document,before:null}]},
    {...base,documents:[{...document,after:9}]},{...base,documents:[{...document,before:'x'.repeat(12001)}]},
    {...base,documents:[{...document,after:'x'.repeat(12001)}]},
  ];
  for(const value of invalid){
    assert.equal(cache.saveNoteOperation(value as FileGenerationNoteOperation),false);
    assert.equal(cache.saveNoteOperation(base),true);replace(storage,'note-operation',record=>({...record,value}));
    assert.equal(cache.readNoteOperation(),undefined);
  }
  assert.equal(cache.saveNoteOperation({note:'非空',documents:[{document_type:'issuer',before:'',after:''}]}),true);
  assert.deepEqual(cache.readNoteOperation(),{note:'非空',documents:[{document_type:'issuer',before:'',after:''}]});
});

test('file generation note operation roundtrips all twelve document types at escaped text limits',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','api-project',storage),text='\u0000'.repeat(12000);
  const maximum:FileGenerationNoteOperation={note:text,documents:PROJECT_DOCUMENT_CATALOG.map(d=>({document_type:d.id,before:text,after:text}))};
  assert.equal(cache.saveNoteOperation(maximum),true);assert.deepEqual(cache.readNoteOperation(),maximum);
  const raw=[...storage.values.values()][0];assert.ok(raw.length>1800000);assert.ok(raw.length<=2000000);
});

test('file generation note operation verifies wrapper ownership and separates resource projects',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner:a','api-project',storage),otherOwner=new FileGenerationCache('owner','a:api-project',storage),otherProject=new FileGenerationCache('owner:a','different-api-project',storage);
  assert.equal(cache.saveNoteOperation(operation()),true);
  assert.equal(otherOwner.readNoteOperation(),undefined);assert.equal(otherProject.readNoteOperation(),undefined);
  const raw=[...storage.values.values()][0];
  assert.equal(otherProject.saveNoteOperation(operation()),true);
  const otherKey=[...storage.values.keys()].find(key=>key.includes(':different-api-project:'))!;
  storage.values.set(otherKey,raw);assert.equal(otherProject.readNoteOperation(),undefined);
  for(const change of [
    (r:Record<string,unknown>)=>({...r,owner:'another-owner'}),
    (r:Record<string,unknown>)=>({...r,project:'navigation-project'}),
    (r:Record<string,unknown>)=>({...r,version:'unknown'}),
    (r:Record<string,unknown>)=>({...r,extra:true}),
    (r:Record<string,unknown>)=>({version:r.version,owner:r.owner,value:r.value}),
  ]){
    cache.saveNoteOperation(operation());replace(storage,'note-operation',change);assert.equal(cache.readNoteOperation(),undefined);
  }
});

test('file generation note operation safely handles unavailable or corrupted session storage',()=>{
  const broken:FileGenerationCacheStorage={getItem(){throw Error('blocked');},setItem(){throw Error('quota');},removeItem(){throw Error('blocked');}};
  const blocked=new FileGenerationCache('owner','api-project',broken);
  assert.equal(blocked.readNoteOperation(),undefined);assert.equal(blocked.saveNoteOperation(operation()),false);assert.equal(blocked.clearNoteOperation(),false);
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','api-project',storage);cache.saveNoteOperation(operation());
  const key=[...storage.values.keys()][0];
  for(const raw of ['{broken','null','[]','x'.repeat(2000001)]){storage.values.set(key,raw);assert.equal(cache.readNoteOperation(),undefined);}
  for(const [ownerId,projectId] of [['','api-project'],['owner',''],['owner\n','api-project'],['owner','api\nproject']]){
    const invalid=new FileGenerationCache(ownerId,projectId,storage);
    assert.equal(invalid.readNoteOperation(),undefined);assert.equal(invalid.saveNoteOperation(operation()),false);assert.equal(invalid.clearNoteOperation(),false);
  }
});

test('file generation cache tolerates corrupted storage and refuses an empty owner',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','project',storage);
  cache.savePending(request());const key=[...storage.values.keys()][0];
  for(const raw of ['{broken','null','[]','x'.repeat(80001)]){storage.values.set(key,raw);assert.equal(cache.readPending(),undefined);}
  for(const owner of ['', '  ','owner\n']){const invalid=new FileGenerationCache(owner,'project',storage);assert.equal(invalid.savePending(request()),false);assert.equal(invalid.saveSelection([]),false);assert.equal(invalid.saveNote(''),false);assert.equal(invalid.readPending(),undefined);}
});

test('file generation cache handles session-storage failures without throwing',()=>{
  const broken:FileGenerationCacheStorage={getItem(){throw Error('blocked');},setItem(){throw Error('quota');},removeItem(){throw Error('blocked');}},cache=new FileGenerationCache('owner','project',broken);
  assert.equal(cache.readSelection(),undefined);assert.equal(cache.readPending(),undefined);assert.equal(cache.readNote(),undefined);
  assert.equal(cache.saveSelection([]),false);assert.equal(cache.savePending(request()),false);assert.equal(cache.saveNote(''),false);
  assert.equal(cache.clearSelection(),false);assert.equal(cache.clearPending(),false);assert.equal(cache.clearNote(),false);
});

test('file generation cache uses only the current tab session storage by default',()=>{
  const storage=new MemoryStorage(),session=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),local=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  try{
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get:()=>storage});
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw Error('local storage must not be read');}});
    const cache=new FileGenerationCache('owner','project');
    assert.equal(cache.savePending(request()),true);assert.deepEqual(cache.readPending(),request());
    assert.equal(cache.saveNote('\n'.repeat(12000)),true);assert.equal(cache.readNote(),'\n'.repeat(12000));
    assert.equal(cache.saveNoteOperation(operation()),true);assert.deepEqual(cache.readNoteOperation(),operation());
  }finally{
    if(session)Object.defineProperty(globalThis,'sessionStorage',session);else Reflect.deleteProperty(globalThis,'sessionStorage');
    if(local)Object.defineProperty(globalThis,'localStorage',local);else Reflect.deleteProperty(globalThis,'localStorage');
  }
});

test('entry cache health distinguishes no record from valid legacy empty choices and returns complete frozen recovery scope',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','api-project',storage);
  const absent=cache.readForEntry();assert.equal(absent.status,'ok');
  if(absent.status==='ok'){assert.equal(absent.selection,undefined);assert.equal(absent.pending,undefined);assert.equal(absent.note,undefined);assert.equal(absent.noteOperation,undefined);}
  cache.saveSelection([]);cache.savePending(request());cache.saveNote('');cache.saveNoteOperation(operation());
  const restored=cache.readForEntry();assert.equal(restored.status,'ok');
  if(restored.status==='ok'){
    assert.deepEqual(restored.selection,[]);assert.deepEqual(restored.pending,request());assert.equal(restored.note,'');assert.deepEqual(restored.noteOperation,operation());
    for(const value of [restored.selection,restored.pending,restored.pending!.documents,restored.pending!.documents[0],restored.noteOperation,restored.noteOperation!.documents,restored.noteOperation!.documents[0]])assert.equal(Object.isFrozen(value),true);
    const again=cache.readForEntry();assert.equal(again.status,'ok');if(again.status==='ok'){assert.notEqual(again.selection,restored.selection);assert.notEqual(again.pending,restored.pending);assert.notEqual(again.noteOperation,restored.noteOperation);}
  }
  for(const raw of storage.values.values())assert.equal(JSON.parse(raw).version,'file-generation-cache-v1');
});

test('entry cache health treats any malformed original record as unknown without deleting or replacing it',()=>{
  const valid={selection:['issuer'],pending:request(),note:'保留原文', 'note-operation':operation()};
  for(const kind of Object.keys(valid) as (keyof typeof valid)[]){
    const storage=new MemoryStorage(),cache=new FileGenerationCache('owner','api-project',storage);
    cache.saveSelection(['issuer']);cache.savePending(request());cache.saveNote('保留原文');cache.saveNoteOperation(operation());
    const cacheKey=[...storage.values.keys()].find(key=>key.endsWith(':'+kind))!;
    const original=storage.values.get(cacheKey)!;
    const badValues=kind==='selection'?[null,['unknown'],['issuer','issuer']]:kind==='pending'?[null,{...request(),documents:[]}]:kind==='note'?[9,'x'.repeat(12001)]:[null,{...operation(),documents:[]}];
    const malformed=['{broken','null','[]','x'.repeat(kind==='note-operation'?2000001:80001),
      ...badValues.map(value=>JSON.stringify({...JSON.parse(original),value})),
      ...[{owner:'another-owner'},{project:'navigation-project'},{version:'future-format'},{extra:true}].map(change=>JSON.stringify({...JSON.parse(original),...change}))];
    for(const raw of malformed){storage.values.set(cacheKey,raw);const before=[...storage.values];assert.deepEqual(cache.readForEntry(),{status:'unknown'});assert.deepEqual([...storage.values],before);}
    storage.values.set(cacheKey,original);assert.equal(cache.readForEntry().status,'ok');
  }
});

test('entry cache health is unknown on a read exception or missing identity and isolates owner and API project namespaces',()=>{
  const storage=new MemoryStorage(),cache=new FileGenerationCache('owner:a','api-project',storage);cache.saveSelection(['issuer']);cache.savePending(request());cache.saveNote('原项目要求');cache.saveNoteOperation(operation());
  for(const other of [new FileGenerationCache('owner','a:api-project',storage),new FileGenerationCache('owner:a','navigation-project',storage)]){
    const state=other.readForEntry();assert.equal(state.status,'ok');if(state.status==='ok'){assert.equal(state.selection,undefined);assert.equal(state.pending,undefined);assert.equal(state.note,undefined);assert.equal(state.noteOperation,undefined);}
  }
  const broken:FileGenerationCacheStorage={getItem(){throw Error('read blocked');},setItem(){throw Error('must not write');},removeItem(){throw Error('must not remove');}};
  assert.deepEqual(new FileGenerationCache('owner:a','api-project',broken).readForEntry(),{status:'unknown'});
  for(const [ownerId,projectId] of [['','api-project'],['owner',''],['owner\n','api-project'],['owner','api\nproject']])assert.deepEqual(new FileGenerationCache(ownerId,projectId,storage).readForEntry(),{status:'unknown'});
  const session=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  try{Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get(){throw Error('unavailable');}});assert.deepEqual(new FileGenerationCache('owner','api-project').readForEntry(),{status:'unknown'});}
  finally{if(session)Object.defineProperty(globalThis,'sessionStorage',session);else Reflect.deleteProperty(globalThis,'sessionStorage');}
  assert.equal(cache.readForEntry().status,'ok');
});
