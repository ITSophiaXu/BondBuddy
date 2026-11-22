import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {digest} from '@bondbuddy/api/data';
import {emptyUpdateDetails} from '@bondbuddy/contracts';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {makeWorkerDocxFixture} from './docx-test-fixture.js';
import {AuthoringSourceUnreadable,prepareFormatSource} from './file-authoring-format.js';
import {fileAuthoringStage} from './file-authoring-stage.js';
import type {UnifiedInput} from './unified-input.js';
import type {StageContext} from './run-pipeline.js';

const python=!!(process.env.BONDBUDDY_TEST_PYTHON||process.env.BONDBUDDY_WORD_PYTHON);
function fixture(bytes:Buffer){
  const pin={material_id:'synthetic-source',material_version:1,sha256:digest(bytes),role:'historical'};
  const input:UnifiedInput={requirements:[],materials:[{pin,filename:'source.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:'source',records:[]}],
    manifest:{issuer_name:'合成发行人',market:'sse',offering:'private',materials:[pin],update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},
      authoring:{version:'unified_v1',requirements:[],source_prospectuses:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval',
        format_policy:{version:'source-format-v1',mode:'preserve_docx',selection:'automatic',template:{kind:'material',material_id:pin.material_id,material_version:1,sha256:pin.sha256}}}}};
  const ctx={run:{id:'synthetic-run',owner_user_id:'owner',project_id:'project',input_hash:'a'.repeat(64)},lease:{checkpoint:{}},signal:new AbortController().signal,
    values:new Map(),blobs:{getIfExistsBounded:async()=>bytes}} as unknown as StageContext;
  return {input,ctx};
}

for(const fault of ['truncated','not-zip'] as const)test(`actual prepare classifies ${fault} DOCX before any supplier call`,{skip:!python},async()=>{
  const bytes=fault==='truncated'?makeWorkerDocxFixture({externalLink:false}).subarray(0,150):Buffer.from('SYNTHETIC bad DOCX');
  const {input,ctx}=fixture(bytes),root=await mkdtemp(join(tmpdir(),'bb-source-fault-'));let supplierCalls=0;
  try{
    const stage=fileAuthoringStage({load:async()=>input,model:options=>({name:'model_generation',run:async()=>{
      // Exercise the production prepare callback with its real Python package.
      // The contained adapter records intent and spawns the supplier only after it.
      await options.fileWorkspace!.prepare(root);supplierCalls++;
      assert.fail('An unreadable source reached the supplier');
    }})});
    assert.deepEqual(await stage.run(ctx),{kind:'fail',code:'MATERIAL_UNREADABLE'});
    assert.equal(supplierCalls,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('corrected source produces its real source-bound manifest and reaches the supplier once',{skip:!python},async()=>{
  const source=makeWorkerDocxFixture({externalLink:false,text:'SYNTHETIC corrected source'}),{input,ctx}=fixture(source);
  const root=await mkdtemp(join(tmpdir(),'bb-source-corrected-'));let supplierCalls=0;
  try{
    const stage=fileAuthoringStage({load:async()=>input,model:options=>({name:'model_generation',run:async()=>{
      await options.fileWorkspace!.prepare(root);supplierCalls++;
      const manifest=JSON.parse(await readFile(join(root,'template-manifest.json'),'utf8'));
      assert.equal(manifest.baseline_sha256,digest(source));assert.equal(manifest.nodes[0].text,'SYNTHETIC corrected source');
      return {kind:'done',value:{synthetic:true}};
    }})});
    assert.equal((await stage.run(ctx)).kind,'done');assert.equal(supplierCalls,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a missing source remains a host error rather than an unreadable material',{skip:!python},async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-source-missing-'));
  try{
    await writeFile(join(root,'input.json'),JSON.stringify({input_hash:'a'.repeat(64),revision_author:'BondBuddy-synthetic',baseline_path:'source.docx',baseline_sha256:'b'.repeat(64)}));
    await assert.rejects(prepareFormatSource(join(root,'input.json'),join(root,'manifest.json')),
      error=>!(error instanceof AuthoringSourceUnreadable));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a valid source with an unwritable manifest destination keeps the infrastructure failure',{skip:!python},async()=>{
  const root=await mkdtemp(join(tmpdir(),'bb-source-host-fault-')),source=makeWorkerDocxFixture({externalLink:false});
  try{
    await writeFile(join(root,'source.docx'),source);
    await writeFile(join(root,'input.json'),JSON.stringify({input_hash:'a'.repeat(64),revision_author:'BondBuddy-synthetic',baseline_path:'source.docx',baseline_sha256:digest(source)}));
    await assert.rejects(prepareFormatSource(join(root,'input.json'),join(root,'missing/manifest.json')),
      error=>!(error instanceof AuthoringSourceUnreadable));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('stage never disguises IO, cancellation or unexpected errors as a bad source',async()=>{
  const {input,ctx}=fixture(makeWorkerDocxFixture({externalLink:false}));
  for(const error of [Object.assign(Error('synthetic IO failure'),{code:'EIO'}),new TypeError('synthetic adapter failure')]){
    const stage=fileAuthoringStage({load:async()=>input,config:loadCodexAdapterConfig({}),model:()=>({name:'model_generation',run:async()=>{throw error;}})});
    await assert.rejects(stage.run(ctx),actual=>actual===error);
  }
  const controller=new AbortController();ctx.signal=controller.signal;controller.abort();
  const aborted=new AuthoringSourceUnreadable();
  const stage=fileAuthoringStage({load:async()=>input,config:loadCodexAdapterConfig({}),model:()=>({name:'model_generation',run:async()=>{throw aborted;}})});
  await assert.rejects(stage.run(ctx),error=>error===aborted);
});
