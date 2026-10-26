import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, Problem, uid } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { inputManifestHash } from './production-rule-pin.js';
import { loadRunSupplementFilePreparation } from './run-supplement-preparation.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';

const connection=await isolatedTestDatabase(undefined,'run-supplement-file-preparation');
const denied=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';
type Fixture=Awaited<ReturnType<typeof createRunSupplementFilePreparationFixture>>;
const pin=(value:{material_id:string;material_version:number;sha256:string})=>({material_id:value.material_id,material_version:value.material_version,sha256:value.sha256});
const complete=(value:Fixture['first'])=>({...pin(value),role:value.role,source_project_id:value.source_project_id});
async function unchanged<T>(fixture:Fixture,operation:()=>Promise<T>){
  const before=await fixture.snapshot(),result=await operation();assert.deepEqual(await fixture.snapshot(),before);return result;
}

for(const kind of ['review','m4'] as const){
  test(`real saved ${kind} files and candidate materials produce one exact read-only preparation`,
    {skip:!connection,timeout:120000},async()=>{
    const f=await createRunSupplementFilePreparationFixture(connection!,kind);try{
      const prepared=await unchanged(f,()=>loadRunSupplementFilePreparation(f.preparationInput,kind));
      assert.equal(prepared.version,'run-supplement-file-preparation-v1');assert.equal(prepared.kind,kind);
      assert.equal(prepared.owner,f.owner);assert.equal(prepared.projectId,f.projectId);assert.equal(prepared.runId,f.runId);
      assert.equal(prepared.requestId,f.saved.request_id);assert.equal(prepared.revision,1);
      assert.deepEqual(prepared.sourceExecution,{executionVersion:1,inputRevision:f.inputRevision,inputHash:f.hash});
      assert.equal(prepared.checkpointHash,inputManifestHash(f.checkpoint));
      assert.equal(prepared.requestHash,inputManifestHash(f.request));assert.equal(prepared.candidateInputHash,f.saved.input_preview.candidate_input_hash);
      assert.notEqual(prepared.candidateInputHash,f.hash);assert.equal(inputManifestHash(prepared.manifest),prepared.candidateInputHash);
      assert.deepEqual(prepared.delta.additions,[complete(f.added)]);assert.equal(prepared.delta.discardPreviousOutput,false);
      const expected=f.replacement?[f.first,f.replacement,f.last,f.added]:[f.first,f.original,f.last,f.added];
      assert.deepEqual(prepared.materials.map(value=>value.pin),expected.map(complete));
      assert.deepEqual(prepared.materials.map(value=>value.objectKey),expected.map(value=>value.objectKey));
      assert.deepEqual(prepared.delta.replacements,f.replacement?[{previous:complete(f.original),current:complete(f.replacement)}]:[]);
      assert.deepEqual(prepared.delta.unchanged,(f.replacement?[f.first,f.last]:f.materials).map(complete));
      assert.deepEqual(prepared.priorWork.source,{kind:'provider_result',resultId:f.selected.result.id,
        resultSchemaVersion:kind==='review'?'codex-review-file-v1':'codex-m4-document-v1'});
      assert.notEqual(prepared.priorWork.source.resultId,f.unrelated.result.id);
      assert.equal(prepared.priorWork.resultHash,f.selected.result.result_sha256.trim());
      assert.deepEqual(prepared.priorWork.files.map(value=>value.name).sort(),Object.keys(f.files).sort());
      for(const file of prepared.priorWork.files){
        assert.equal(file.sourceHash,prepared.priorWork.resultHash);assert.equal(file.inputHash,f.hash);
        assert.deepEqual(f.objects.get(file.key),f.fileBytes.get(file.name));assert.equal(file.sha256,digest(f.fileBytes.get(file.name)!));
      }
      if(kind==='review'){
        assert.deepEqual(prepared.manifest.review.file_delivery,f.manifest.review.file_delivery);
        assert.deepEqual(prepared.manifest.review.origin,f.manifest.review.origin);
        assert.deepEqual(prepared.manifest.review.input.requirements,f.manifest.review.input.requirements);
        assert.deepEqual(prepared.manifest.review.input.source_material_ref,pin(f.replacement!));
        assert.deepEqual((prepared.reviewSnapshot as any).input,prepared.manifest.review.input);
        assert.deepEqual((prepared.reviewSnapshot as any).origin,f.manifest.review.origin);
        assert.deepEqual(prepared.priorWork.metadata,{});
      }else{
        assert.notEqual(f.first.source_project_id,f.projectId,'frozen main source is genuinely cross-project');
        for(const field of ['knowledge','template_material','execution_scope_project_id','topic_id'])
          assert.deepEqual(prepared.manifest[field],f.manifest[field]);
        for(const field of ['source_material','template','requirements','fields','edit_base'])
          assert.deepEqual(prepared.manifest.input[field],f.manifest.input[field]);
        assert.deepEqual(prepared.priorWork.metadata,{method_hash:inputManifestHash(f.method),skill_sha256:f.method.skill_sha256});
        assert.equal(prepared.reviewSnapshot,null);
      }
      const {planHash,...body}=prepared;assert.equal(planHash,inputManifestHash(body));
      await f.save(1);
      assert.deepEqual(await unchanged(f,()=>loadRunSupplementFilePreparation(f.preparationInput,kind)),prepared,
        'a newer saved receipt at the same paused checkpoint cannot retarget the explicit old receipt');
    }finally{await f.cleanup();}
  });

  test(`${kind} preparation rejects wrong scope, receipt, hashes, business kind and stale live checkpoint`,
    {skip:!connection,timeout:120000},async t=>{
    const f=await createRunSupplementFilePreparationFixture(connection!,kind);try{
      for(const [name,overrides] of [['owner',{owner:`foreign-${uid()}`}],['project',{projectId:uid()}],['run',{runId:uid()}],
        ['receipt',{revision:999}],['checkpoint',{expectedCheckpointHash:'a'.repeat(64)}],['candidate',{expectedCandidateInputHash:'b'.repeat(64)}]] as const)
        await t.test(name,()=>unchanged(f,()=>assert.rejects(loadRunSupplementFilePreparation({...f.preparationInput,...overrides},kind),denied)));
      await unchanged(f,()=>assert.rejects(loadRunSupplementFilePreparation(f.preparationInput,kind==='review'?'m4':'review'),denied));
      await f.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,{...f.checkpoint,new_boundary:true}]);
      await unchanged(f,()=>assert.rejects(loadRunSupplementFilePreparation(f.preparationInput,kind),denied));
    }finally{await f.cleanup();}
    for(const options of [{wrongCheckpointPrompt:true},{partial:true}]){
      const invalid=await createRunSupplementFilePreparationFixture(connection!,kind,options);try{
        await unchanged(invalid,()=>assert.rejects(loadRunSupplementFilePreparation(invalid.preparationInput,kind),denied));
      }finally{await invalid.cleanup();}
    }
  });

  test(`${kind} preparation reads every declared old file and candidate material byte without writing or calling a model`,
    {skip:!connection,timeout:120000},async t=>{
    const f=await createRunSupplementFilePreparationFixture(connection!,kind);try{
      const expected=f.replacement?[f.first,f.replacement,f.last,f.added]:[...f.materials,f.added];
      const sources=[...Object.entries(f.files).map(([name,file])=>({name:`old ${name}`,key:file.key})),
        ...expected.map(material=>({name:`candidate ${material.material_id}`,key:material.objectKey}))];
      for(const {name,key} of sources)await t.test(name,async()=>{
        const bytes=f.objects.get(key)!;f.objects.delete(key);
        try{await unchanged(f,()=>assert.rejects(loadRunSupplementFilePreparation(f.preparationInput,kind),denied));}
        finally{f.objects.set(key,bytes);}
      });
      for(const key of [f.files[kind==='review'?'report.docx':'document.docx']!.key,f.added.objectKey]){
        const bytes=f.objects.get(key)!,corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;f.objects.set(key,corrupt);
        try{await unchanged(f,()=>assert.rejects(loadRunSupplementFilePreparation(f.preparationInput,kind),denied));}
        finally{f.objects.set(key,bytes);}
      }
    }finally{await f.cleanup();}
  });
}

test('differential review retains its exact frozen source report and finding scope while replacing its draft source',
  {skip:!connection,timeout:120000},async()=>{
  const f=await createRunSupplementFilePreparationFixture(connection!,'review',{operation:'differential_review'});try{
    assert.ok(f.sourceReport);assert.equal(f.inputRevision,2);
    const prepared=await unchanged(f,()=>loadRunSupplementFilePreparation(f.preparationInput,'review'));
    assert.equal(prepared.manifest.review.operation,'differential_review');
    assert.equal(prepared.manifest.review.source_report_id,f.sourceReport.id);
    assert.equal(prepared.manifest.review.source_report_sha256,f.sourceReport.sha256);
    assert.deepEqual(prepared.manifest.review.finding_ids,[f.sourceReport.findingId]);
    assert.deepEqual((prepared.reviewSnapshot as any).finding_ids,[f.sourceReport.findingId]);
    assert.deepEqual(prepared.manifest.review.input.source_material_ref,pin(f.replacement!));
    const source=(await f.pool.query(`SELECT report FROM bb_review_execution_reports WHERE owner_user_id=$1 AND project_id=$2 AND id=$3`,
      [f.owner,f.projectId,f.sourceReport.id])).rows[0].report;
    assert.equal(inputManifestHash(source),f.sourceReport.sha256);assert.deepEqual(source.source_material,pin(f.original));
  }finally{await f.cleanup();}
});
