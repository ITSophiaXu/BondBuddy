import assert from 'node:assert/strict';
import test from 'node:test';
import { Problem, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture, type RunSupplementEarlyPause } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { loadRunSupplementAuthoringPreparation, loadRunSupplementFilePreparation, loadRunSupplementProcessingBasis,
  type RunSupplementProcessingKind } from './run-supplement-preparation.js';
import { createRunSupplementProcessingPlan, readRunSupplementProcessingPlan, type RunSupplementProcessingPlan } from './run-supplement-processing-plan.js';

const connection=await isolatedTestDatabase(undefined,'run-supplement-processing-plan');
const denied=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';
async function fixture(kind:RunSupplementProcessingKind,earlyPause?:RunSupplementEarlyPause){
  if(kind==='authoring')return earlyPause?createRunSupplementPreparationFixture(connection!,{earlyPause}):
    createRunSupplementPreparationFixture(connection!);
  return earlyPause?createRunSupplementFilePreparationFixture(connection!,kind,{earlyPause}):
    createRunSupplementFilePreparationFixture(connection!,kind);
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const rows=async(f:Fixture)=>(await f.pool.query(`SELECT * FROM bb_run_supplement_processing_plans
  WHERE owner_user_id=$1 ORDER BY id`,[f.owner])).rows;
async function unchanged<T>(f:Fixture,operation:()=>Promise<T>){
  const before=await f.snapshot(),plans=await rows(f),result=await operation();
  assert.deepEqual(await f.snapshot(),before);assert.deepEqual(await rows(f),plans);return result;
}
async function create(f:Fixture,kind:RunSupplementProcessingKind,requestId=uid()){
  const basis=await loadRunSupplementProcessingBasis(f.preparationInput,kind);
  return createRunSupplementProcessingPlan({...f.preparationInput,kind,requestId,expectedBasisHash:basis.basisHash});
}
async function read(f:Fixture,kind:RunSupplementProcessingKind,plan:RunSupplementProcessingPlan){
  return readRunSupplementProcessingPlan({...f.preparationInput,kind,planId:plan.id});
}

for(const kind of ['authoring','review','m4'] as const){
  test(`${kind} persists and reloads the exact complete-work processing plan without changing run, input, queue or accounting`,
    {skip:!connection,timeout:120000},async()=>{
    const f=await fixture(kind);try{
      const before=await f.snapshot(),basis=await loadRunSupplementProcessingBasis(f.preparationInput,kind);
      assert.equal(basis.version,'run-supplement-processing-basis-v1');assert.equal(basis.kind,kind);
      assert.equal(basis.priorWorkStatus,'captured_complete');assert.ok(basis.priorWork);
      assert.deepEqual(basis.priorWork.files.map(file=>file.name).sort(),Object.keys(f.files).sort());
      assert.deepEqual(basis.priorWork.metadata,kind==='m4'?{
        method_hash:inputManifestHash((f as Awaited<ReturnType<typeof createRunSupplementFilePreparationFixture>>).method),
        skill_sha256:(f as Awaited<ReturnType<typeof createRunSupplementFilePreparationFixture>>).method.skill_sha256}:{});
      const {basisHash,...basisBody}=basis;assert.equal(basisHash,inputManifestHash(basisBody));
      const requestId=uid(),plan=await createRunSupplementProcessingPlan({...f.preparationInput,kind,requestId,expectedBasisHash:basisHash});
      assert.equal(plan.planHash,inputManifestHash(plan.body));assert.equal(plan.basisHash,basisHash);
      assert.equal(plan.body.receipt.requestId,f.saved.request_id);assert.equal(plan.body.requestId,requestId);
      assert.deepEqual(plan.body.materials,basis.materials.map(material=>material.pin));
      assert.deepEqual(plan.body.priorWork,basis.priorWork);
      assert.equal(plan.body.recipe.previousWork,kind==='authoring'?'saved_clean_editing_baseline':'source_reference_only');
      assert.equal(plan.body.recipe.candidateScope,'all_candidate_materials');
      assert.equal(plan.body.recipe.retainedClaims,'recheck_against_complete_candidate');
      assert.equal(plan.body.recipe.operationScope,'preserve_frozen_operation_and_selected_findings');
      assert.equal(plan.body.recipe.unsavedScratch,'unavailable');
      for(const field of ['manifest','reviewSnapshot','prompt','report','requirements','knowledge'])assert.equal(Object.hasOwn(plan.body,field),false);
      assert.equal(JSON.stringify(plan.body).includes('Frozen '),false,'only identity and pins, never frozen body text, are persisted');
      assert.deepEqual(await read(f,kind,plan),{plan,basis});
      assert.deepEqual(await f.snapshot(),before);assert.equal((await rows(f)).length,1);
      assert.equal((await f.pool.query('SELECT execution_version FROM bb_run_execution_versions WHERE run_id=$1',[f.runId])).rows.length,1);
    }finally{await f.cleanup();}
  });

  for(const earlyPause of ['before_prompt','after_prompt'] as const){
    test(`${kind} ${earlyPause} is genuine zero-attempt work and can persist a conservative plan`,
      {skip:!connection,timeout:120000},async()=>{
      const f=await fixture(kind,earlyPause);try{
        assert.equal(f.selected,null);assert.equal(f.unrelated,null);assert.equal(Object.keys(f.files).length,0);
        assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_model_call_attempts WHERE job_id=$1',[f.jobId])).rows[0].n,0);
        assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_provider_result_refs WHERE job_id=$1',[f.jobId])).rows[0].n,0);
        assert.equal(f.checkpoint.stages?.model_generation,undefined);
        if(earlyPause==='after_prompt')assert.equal(typeof f.promptSnapshotRef,'string');else assert.equal(f.promptSnapshotRef,null);
        const before=await f.snapshot(),basis=await loadRunSupplementProcessingBasis(f.preparationInput,kind);
        assert.equal(basis.priorWorkStatus,'no_prior_work');assert.equal(basis.priorWork,null);
        assert.equal(basis.materials.length,4);assert.equal(inputManifestHash(basis.manifest),basis.candidateInputHash);
        const plan=await create(f,kind);assert.equal(plan.body.recipe.previousWork,'none');assert.equal(plan.body.priorWork,null);
        assert.deepEqual((await read(f,kind,plan)).basis,basis);
        // Existing complete-work loaders keep their original fail-closed contract.
        await assert.rejects(kind==='authoring'?loadRunSupplementAuthoringPreparation(f.preparationInput):
          loadRunSupplementFilePreparation(f.preparationInput,kind),denied);
        assert.deepEqual(await f.snapshot(),before);assert.equal((await rows(f)).length,1);
      }finally{await f.cleanup();}
    });
  }
}

test('concurrent identical requests return one immutable plan; an idempotency key cannot name a different receipt or basis',
  {skip:!connection,timeout:120000},async()=>{
  const f=await fixture('authoring');try{
    const basis=await loadRunSupplementProcessingBasis(f.preparationInput,'authoring'),requestId=uid();
    const input={...f.preparationInput,kind:'authoring' as const,requestId,expectedBasisHash:basis.basisHash};
    const before=await f.snapshot(),plans=await Promise.all([createRunSupplementProcessingPlan(input),createRunSupplementProcessingPlan(input),
      createRunSupplementProcessingPlan(input)]);
    assert.deepEqual(plans,[plans[0],plans[0],plans[0]]);assert.equal((await rows(f)).length,1);assert.deepEqual(await f.snapshot(),before);
    await unchanged(f,()=>assert.rejects(createRunSupplementProcessingPlan({...input,expectedBasisHash:'c'.repeat(64)}),denied));
    const next=await f.save(1),nextInput={...f.preparationInput,revision:next.revision,
      expectedCandidateInputHash:next.input_preview.candidate_input_hash as string};
    const nextBasis=await loadRunSupplementProcessingBasis(nextInput,'authoring');
    assert.notEqual(nextBasis.basisHash,basis.basisHash);
    await unchanged(f,()=>assert.rejects(createRunSupplementProcessingPlan({...nextInput,kind:'authoring',requestId,
      expectedBasisHash:nextBasis.basisHash}),denied));
    assert.deepEqual((await read(f,'authoring',plans[0]!)).basis,basis,'the explicit old receipt remains exact at the same boundary');
  }finally{await f.cleanup();}
});

test('processing plan reads reject wrong owner, project, run, receipt, kind, identity and live checkpoint',
  {skip:!connection,timeout:120000},async t=>{
  const f=await fixture('review');try{
    const plan=await create(f,'review');
    for(const [name,patch] of [['owner',{owner:`foreign-${uid()}`}],['project',{projectId:uid()}],['run',{runId:uid()}],
      ['receipt',{revision:999}],['kind',{kind:'m4' as const}],['id',{planId:uid()}],
      ['checkpoint',{expectedCheckpointHash:'b'.repeat(64)}],['candidate',{expectedCandidateInputHash:'d'.repeat(64)}]] as const){
      await t.test(name,()=>unchanged(f,()=>assert.rejects(readRunSupplementProcessingPlan({
        ...f.preparationInput,kind:'review',planId:plan.id,...patch}),denied)));
    }
    await f.pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,{...f.checkpoint,new_processing_boundary:true}]);
    await unchanged(f,()=>assert.rejects(read(f,'review',plan),denied));
  }finally{await f.cleanup();}
});

for(const kind of ['authoring','review','m4'] as const){
  test(`${kind} cannot reload purged, corrupt, partial or missing old work as an empty-work plan`,
    {skip:!connection,timeout:120000},async t=>{
    const f=await fixture(kind);try{
      const plan=await create(f,kind);
      for(const [name,key] of [...Object.entries(f.files).map(([name,file])=>[`prior ${name}`,file.key] as const),
        ['unchanged candidate',f.first.objectKey],['added candidate',f.added.objectKey]] as const){
        await t.test(name,async()=>{
          const original=f.objects.get(key)!;f.objects.delete(key);
          try{await unchanged(f,()=>assert.rejects(read(f,kind,plan),denied));}finally{f.objects.set(key,original);}
        });
      }
      const file=Object.values(f.files)[0]!,original=f.objects.get(file.key)!,corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;
      f.objects.set(file.key,corrupt);
      try{await unchanged(f,()=>assert.rejects(loadRunSupplementProcessingBasis(f.preparationInput,kind),denied));}
      finally{f.objects.set(file.key,original);}
      await f.pool.query(`UPDATE bb_run_working_object_state SET purge_started_at=now(),purge_reason='synthetic_test',policy_version='synthetic_v1'
        WHERE object_key=$1`,[file.key]);
      await unchanged(f,()=>assert.rejects(read(f,kind,plan),denied));
    }finally{await f.cleanup();}
    const partial=kind==='authoring'?await createRunSupplementPreparationFixture(connection!,{partial:true}):
      await createRunSupplementFilePreparationFixture(connection!,kind,{partial:true});
    try{await unchanged(partial,()=>assert.rejects(loadRunSupplementProcessingBasis(partial.preparationInput,kind),denied));}
    finally{await partial.cleanup();}
  });
}

test('an early pause with any durable attempt history cannot claim no prior work even when no call was sent',
  {skip:!connection,timeout:120000},async()=>{
  const f=await fixture('authoring','after_prompt');try{
    const plan=await create(f,'authoring');assert.ok(f.promptSnapshotRef);
    // Inject contradictory durable history as a negative fixture. No completed
    // attempt or immutable saved checkpoint is deleted or rewritten.
    await f.pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,prompt_snapshot_id)
      VALUES($1,$2,$3,'file-authoring-v1',1,'confirmed_not_sent',$4)`,[uid(),f.owner,f.jobId,f.promptSnapshotRef]);
    await unchanged(f,()=>assert.rejects(loadRunSupplementProcessingBasis(f.preparationInput,'authoring'),denied));
    await unchanged(f,()=>assert.rejects(read(f,'authoring',plan),denied));
  }finally{await f.cleanup();}
});

test('Blob I/O holds no project/run/job locks and a boundary change while reading prevents a plan commit',
  {skip:!connection,timeout:120000},async()=>{
  const f=await fixture('authoring');let release=()=>{};try{
    const basis=await loadRunSupplementProcessingBasis(f.preparationInput,'authoring');
    let entered=()=>{};const waiting=new Promise<void>(resolve=>{entered=resolve;}),barrier=new Promise<void>(resolve=>{release=resolve;});
    const target=Object.values(f.files)[0]!.key;
    const blobs={...f.blobs,getIfExistsBounded:async(key:string,max:number)=>{
      if(key===target){entered();await barrier;}return f.blobs.getIfExistsBounded(key,max);
    }};
    const pending=assert.rejects(createRunSupplementProcessingPlan({...f.preparationInput,blobs,kind:'authoring',requestId:uid(),
      expectedBasisHash:basis.basisHash}),denied);
    await waiting;
    const client=await f.pool.connect();try{
      await client.query('BEGIN');
      await client.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE NOWAIT',[f.projectId]);
      await client.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE NOWAIT',[f.runId]);
      await client.query('SELECT id FROM bb_jobs WHERE id=$1 FOR UPDATE NOWAIT',[f.jobId]);
      await client.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.jobId,{...f.checkpoint,changed_during_byte_read:true}]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const before=await f.snapshot();release();await pending;
    assert.deepEqual(await f.snapshot(),before);assert.equal((await rows(f)).length,0);
  }finally{release();await f.cleanup();}
});

test('SQL plans reject arbitrary recipes, wrong source identity and edits or deletion; persisted metadata grants no retention pin',
  {skip:!connection,timeout:120000},async()=>{
  const f=await fixture('authoring','before_prompt');try{
    const plan=await create(f,'authoring'),stored=(await rows(f))[0]!;
    const columns=['id','owner_user_id','project_id','run_id','supplement_revision','job_id','kind','request_id','receipt_request_id','receipt_request_hash',
      'execution_version','input_revision','input_hash','checkpoint_hash','candidate_input_hash','basis_hash','plan_hash','body'];
    async function insert(patch:Record<string,unknown>){
      const row={...stored,id:uid(),request_id:uid(),...patch};
      row.body={...row.body,requestId:row.request_id};
      const values=columns.map(column=>row[column]);
      return f.pool.query(`INSERT INTO bb_run_supplement_processing_plans(${columns.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')})`,values);
    }
    const check=(constraint:string)=>(error:unknown)=>!!error&&typeof error==='object'&&(error as any).code==='23514'&&(error as any).constraint===constraint;
    await unchanged(f,()=>assert.rejects(insert({body:{...plan.body,recipe:{...plan.body.recipe,candidateScope:'additions_only'}}}),check('bb_supplement_processing_plan_recipe')));
    await unchanged(f,()=>assert.rejects(insert({input_hash:'e'.repeat(64)}),check('bb_supplement_processing_plan_origin')));
    await unchanged(f,()=>assert.rejects(insert({body:{...plan.body,manifest:{private_body:'must not be persisted'}}}),check('bb_supplement_processing_plan_recipe')));
    await unchanged(f,()=>assert.rejects(f.pool.query(`UPDATE bb_run_supplement_processing_plans SET body=body WHERE id=$1`,[plan.id]),
      (error:unknown)=>(error as any)?.code==='23514'));
    await unchanged(f,()=>assert.rejects(f.pool.query(`DELETE FROM bb_run_supplement_processing_plans WHERE id=$1`,[plan.id]),
      (error:unknown)=>(error as any)?.code==='23514'));
    assert.equal((await f.pool.query(`SELECT bb_material_bytes_pinned($1,$2,$3,$4) AS pinned`,
      [f.owner,f.projectId,f.added.material_id,f.added.material_version])).rows[0].pinned,false,
      'candidate-only material is not retained by the saved receipt or durable plan');
  }finally{await f.cleanup();}
});
