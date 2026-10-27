import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedTestDatabase } from './test-database.js';
import { digest, Problem, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { loadRunSupplementAuthoringPreparation } from './run-supplement-preparation.js';
import { createRunSupplementPreparationTestContext } from './run-supplement-preparation-test-fixture.js';
const connection=await isolatedTestDatabase(undefined,'run-supplement-preparation');
const schema='codex-file-word-v1';
const denied=(error:unknown)=>error instanceof Problem && error.status===409 && error.code==='INPUT_REVISION_CONFLICT';
const pin=(value:{material_id:string;material_version:number;sha256:string})=>({material_id:value.material_id,material_version:value.material_version,sha256:value.sha256});

test('real HTTP-captured authoring work and material delta become one exact read-only continuation package',
  {skip:!connection,timeout:120000},async()=>{
  const c=await createRunSupplementPreparationTestContext(connection!);try{
    const f=await c.fixture(),saved=await f.save(),prepared=await c.unchanged(()=>loadRunSupplementAuthoringPreparation(c.args(f,saved)));
    assert.equal(prepared.version,'run-supplement-authoring-preparation-v1');
    assert.equal(prepared.owner,c.owner);assert.equal(prepared.projectId,f.projectId);assert.equal(prepared.runId,f.runId);assert.equal(prepared.revision,1);
    assert.equal(prepared.requestId,saved.request_id);assert.equal(prepared.checkpointHash,inputManifestHash(f.checkpoint));
    assert.deepEqual(prepared.sourceExecution,{executionVersion:1,inputRevision:1,inputHash:f.hash});
    assert.equal(prepared.candidateInputHash,saved.input_preview.candidate_input_hash);assert.notEqual(prepared.candidateInputHash,f.hash);
    assert.equal(inputManifestHash(prepared.manifest),prepared.candidateInputHash);
    const complete=(value:typeof f.first)=>({...pin(value),role:value.role,source_project_id:f.projectId});
    assert.deepEqual(prepared.delta.additions,[complete(f.added)]);
    assert.deepEqual(prepared.delta.replacements,[{previous:complete(f.original),current:complete(f.replacement)}]);
    assert.deepEqual(prepared.delta.unchanged,[complete(f.first),complete(f.last)]);
    assert.deepEqual(prepared.delta.sourceProspectuses,{previous:[],current:[]});assert.equal(prepared.delta.discardPreviousOutput,false);
    assert.deepEqual(prepared.materials.map(value=>value.pin),[f.first,f.replacement,f.last,f.added].map(value=>({...pin(value),role:value.role})));
    assert.deepEqual(prepared.materials.map(value=>value.objectKey),[f.first,f.replacement,f.last,f.added].map(value=>value.objectKey));
    assert.deepEqual(prepared.priorWork.source,{kind:'provider_result',resultId:f.selected.result.id,resultSchemaVersion:schema});
    assert.equal(prepared.priorWork.resultHash,f.selected.result.result_sha256.trim());assert.notEqual(prepared.priorWork.source.resultId,f.unrelated.result.id);
    assert.deepEqual(prepared.priorWork.files.map(value=>value.name).sort(),['baseline.docx','clean.docx','delivery.md','tracked.docx']);
    for(const file of prepared.priorWork.files){assert.equal(file.sourceHash,prepared.priorWork.resultHash);assert.equal(file.inputHash,f.hash);
      assert.deepEqual(c.objects.get(file.key),f.selected.fileBytes.get(file.name));assert.equal(file.sha256,digest(f.selected.fileBytes.get(file.name)!));}
    assert.match(prepared.planHash,/^[a-f0-9]{64}$/);assert.match(prepared.requestHash,/^[a-f0-9]{64}$/);
    await f.save(1);
    assert.deepEqual(await c.unchanged(()=>loadRunSupplementAuthoringPreparation(c.args(f,saved))),prepared,
      'a later receipt at the identical paused boundary does not retarget the explicitly requested old receipt');
  }finally{await c.close();}
});

test('preparation rejects stale scope, caller hashes and a checkpoint that does not bind its captured file result',
  {skip:!connection,timeout:120000},async t=>{
  const c=await createRunSupplementPreparationTestContext(connection!);try{
    const f=await c.fixture(),saved=await f.save();
    for(const [name,overrides] of [['owner',{owner:`foreign-${uid()}`}],['project',{projectId:uid()}],['run',{runId:uid()}],
      ['receipt',{revision:999}],['checkpoint hash',{expectedCheckpointHash:'b'.repeat(64)}],['candidate hash',{expectedCandidateInputHash:'c'.repeat(64)}]] as const)
      await t.test(name,()=>c.unchanged(()=>assert.rejects(loadRunSupplementAuthoringPreparation(c.args(f,saved,overrides)),denied)));
    await c.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,{...f.checkpoint,stale_preparation_marker:true}]);
    await c.unchanged(()=>assert.rejects(loadRunSupplementAuthoringPreparation(c.args(f,saved)),denied));
    const wrong=await c.fixture({wrongCheckpointPrompt:true}),wrongSaved=await wrong.save();
    await c.unchanged(()=>assert.rejects(loadRunSupplementAuthoringPreparation(c.args(wrong,wrongSaved)),denied));
  }finally{await c.close();}
});

test('missing prior or candidate material bytes and rejected partial work stop preparation without writes or another call',
  {skip:!connection,timeout:120000},async t=>{
  const c=await createRunSupplementPreparationTestContext(connection!);try{
    const f=await c.fixture(),saved=await f.save();
    const missing=[...Object.entries(f.selected.files).map(([name,file])=>[name,file.key] as const),
      ['unchanged material',f.first.objectKey],['replacement material',f.replacement.objectKey],['added material',f.added.objectKey]] as const;
    for(const [name,key] of missing)await t.test(name,async()=>{
      const original=c.objects.get(key)!;c.objects.delete(key);
      try{await c.unchanged(()=>assert.rejects(loadRunSupplementAuthoringPreparation(c.args(f,saved)),denied));}
      finally{c.objects.set(key,original);}
    });
    const original=c.objects.get(f.selected.files['clean.docx']!.key)!,corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;
    c.objects.set(f.selected.files['clean.docx']!.key,corrupt);
    await c.unchanged(()=>assert.rejects(loadRunSupplementAuthoringPreparation(c.args(f,saved)),denied));
    const partial=await c.fixture({partial:true}),partialSaved=await partial.save();
    await c.unchanged(()=>assert.rejects(loadRunSupplementAuthoringPreparation(c.args(partial,partialSaved)),denied));
  }finally{await c.close();}
});
