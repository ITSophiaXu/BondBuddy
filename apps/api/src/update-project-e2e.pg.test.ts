import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { emptyUpdateDetails, INITIAL_FIXED_PRICES } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs,digest,transaction } from './data.js';
import { publishPrices,grantCredits } from './billing.js';
import { claim,checkpointStage,finish,promoteWordArtifact } from './queue.js';
import { registerGeneratedProspectus } from './prospectus-versions.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { readFile } from 'node:fs/promises';
import { pdfSample,PDF,DOCX } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'update-project-e2e');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin='http://bondbuddy.test';
test('update project: real uploads, version CAS, exact input pins, cross-kind reuse, owner isolation and no implicit execution',{skip:!connection||!storage},async()=>{
  const pool=new Pool({connectionString:connection});
  const user=`update-e2e-${randomUUID()}`;let owner=user;
  const container=`bb-update-${randomUUID().replaceAll('-','')}`;
  const blobs=azureBlobs(storage!,container);
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,enablePaidAuthoring:true});
  app.addHook('onError',async(_request,_reply,error)=>{if(!(error as any).status)process.stderr.write(`Synthetic integration diagnostic: ${error.message}\n`);});
  const send=(method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...headers,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:unknown,headers?:Record<string,string>)=>{const r=await send(method,url,payload,headers);assert.ok(r.statusCode<300,r.body);return r.body?r.json():null;};
  const create=(kind:string,request=randomUUID())=>ok('POST','/api/v1/projects',{creation_request_id:request,name:`Synthetic ${kind}`,kind,issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
  const upload=async(id:string,tag:string,role='historical')=>{
    const source=['historical','reference'].includes(role),bytes=source?makeSyntheticDocxFixture({text:tag}):pdfSample({tag}),declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const session=await ok('POST',`/api/v1/projects/${id}/materials/uploads`,{...declaration,filename:`${tag}.${source?'docx':'pdf'}`,role,media_type:source?DOCX:PDF});
    assert.equal((await send('PUT',session.upload_url,bytes)).statusCode,204);
    return ok('POST',`/api/v1/projects/${id}/materials/uploads/${session.upload_id}/complete`,declaration);
  };
  try{
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)',[user,'+8613888888811']);
    const creation=randomUUID(),p=await create('update',creation);
    assert.equal((await create('update',creation)).project_id,p.project_id);
    const path=`/api/v1/projects/${p.project_id}`,vpath=`${path}/prospectus-versions`;
    const first=await upload(p.project_id,'v1'),second=await upload(p.project_id,'v2');
    assert.notEqual(first.material_id,second.material_id);
    const automaticallySelected=await ok('GET',vpath);
    assert.equal(automaticallySelected.selection_revision,2);
    assert.equal(automaticallySelected.versions.find((v:any)=>v.version_id===automaticallySelected.current_version_id).material_id,second.material_id);
    await ok('POST',`${path}/materials/uploads/${first.upload_id}/complete`,{byte_size:first.byte_size,sha256:first.sha256});
    assert.deepEqual(await ok('GET',vpath),automaticallySelected,'an old completion retry cannot overwrite the newer source');
    const selection={request_id:randomUUID(),expected_selection_revision:2,material_id:first.material_id,material_version:1,sha256:first.sha256};
    const selected=await ok('POST',vpath,selection);
    assert.equal(selected.versions.length,2);assert.equal(selected.selection_revision,3);
    assert.deepEqual(selected.inactive_material_ids,[second.material_id]);
    assert.deepEqual(await ok('POST',vpath,selection),selected,'lost selection response replays without another revision');
    assert.equal((await send('POST',vpath,{...selection,sha256:'0'.repeat(64)})).statusCode,409);
    const b={expected_selection_revision:3,material_id:second.material_id,material_version:1,sha256:second.sha256};
    const concurrent=await Promise.all([send('POST',vpath,{...b,request_id:randomUUID()}),send('POST',vpath,{...b,request_id:randomUUID()})]);
    assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,409]);
    const current=await ok('GET',vpath);assert.equal(current.selection_revision,4);
    assert.equal(current.versions.find((v:any)=>v.version_id===current.current_version_id).material_id,second.material_id);
    assert.equal((await ok('GET',`${path}/materials/${first.material_id}`)).sha256,first.sha256,'old version retained');
    let project=await ok('GET',path);
    const source={material_id:second.material_id,material_version:1,sha256:second.sha256,issuer_name:null,relation:'same_issuer',market:'sse',offering:'private',reporting_periods:[{start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]}],status:'user_asserted'};
    project=await ok('PATCH',path,{update_details:{...project.update_details,source_prospectuses:[source]}},{'if-match':String(project.draft_revision)});
    const input={draft_revision:project.draft_revision,prospectus_selection_revision:4,material_versions:[{material_id:second.material_id,material_version:1}],requirement_message_ids:[]};
    const locked=await ok('POST',`${path}/input-revisions`,input);
    const snapshot=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[p.project_id,locked.input_revision])).rows[0].manifest;
    assert.equal(snapshot.materials[0].sha256,second.sha256);assert.equal(snapshot.prospectus_selection.revision,4);
    assert.equal((await send('POST',`${path}/input-revisions`,{...input,prospectus_selection_revision:1})).statusCode,409);
    assert.equal((await send('POST',`${path}/input-revisions`,{...input,material_versions:[...input.material_versions,{material_id:first.material_id,material_version:1}]})).statusCode,409);
    for(const kind of ['review','generation']){
      const source=await create(kind);const original=await upload(source.project_id,`${kind}-history`);await upload(source.project_id,`${kind}-audit`,'audit');
      const sourceDraft=await ok('GET',`/api/v1/projects/${source.project_id}`);
      await ok('PATCH',`/api/v1/projects/${source.project_id}`,{update_details:{...sourceDraft.update_details,
        format_template:{material_id:original.material_id,material_version:1,sha256:original.sha256}}},{'if-match':String(sourceDraft.draft_revision)});
      const route=`/api/v1/projects/${source.project_id}/update-workspace`;
      const [a,b]=await Promise.all([ok('POST',route,{}),ok('POST',route,{})]);
      assert.equal(a.update_project_id,b.update_project_id);assert.notEqual(a.update_project_id,source.project_id);
      assert.equal((await ok('GET',`/api/v1/projects/${source.project_id}`)).kind,kind);
      const target=await ok('GET',`/api/v1/projects/${a.update_project_id}`);
      assert.equal(target.source_project_id,source.project_id);assert.equal(target.kind,'update');
      const copies=(await pool.query('SELECT * FROM bb_material_versions WHERE project_id=$1',[a.update_project_id])).rows;
      assert.equal(copies.length,2);const copy=copies.find(m=>m.role==='historical');
      assert.equal(copy.sha256.trim(),original.sha256);assert.notEqual(copy.id,original.material_id);
      assert.deepEqual(target.update_details.format_template,{material_id:copy.id,material_version:1,sha256:original.sha256},
        'format template is remapped to the private target-project copy');
      assert.equal(digest(await blobs.get(copy.object_key)),original.sha256);
      const listed=await ok('GET','/api/v1/projects');assert.ok(!listed.items.some((p:any)=>p.project_id===a.update_project_id));
      assert.equal(listed.items.find((p:any)=>p.project_id===source.project_id).update_project_id,a.update_project_id);
      assert.equal((await ok('POST',route,{})).update_project_id,a.update_project_id);
      const copiedVersions=await ok('GET',`/api/v1/projects/${a.update_project_id}/prospectus-versions`);
      assert.equal(copiedVersions.versions.find((v:any)=>v.version_id===copiedVersions.current_version_id).material_id,copy.id,'copied historical file is automatically adopted');
      if(kind==='generation'){
        assert.equal((await send('DELETE',`/api/v1/projects/${a.update_project_id}/materials/${copy.id}`)).statusCode,204);
        assert.equal((await ok('GET',`/api/v1/projects/${a.update_project_id}/prospectus-versions`)).current_version_id,null);
        const added=await upload(source.project_id,'newly-added-source');
        await ok('POST',route,{});
        const restored=await ok('GET',`/api/v1/projects/${a.update_project_id}/prospectus-versions`);
        assert.equal(restored.versions.find((v:any)=>v.version_id===restored.current_version_id).sha256,added.sha256,'null selection does not strand newly copied sources');
      }
      assert.equal((await send('DELETE',`/api/v1/projects/${a.update_project_id}`)).statusCode,409,'manage lifecycle through original project');
      assert.equal((await send('DELETE',`/api/v1/projects/${source.project_id}`)).statusCode,204);
      assert.equal((await send('GET',`/api/v1/projects/${a.update_project_id}`)).statusCode,404,'original deletion includes update workspace');
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[user])).rows[0].n,0,'uploads and workspace selection never run AI');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[user])).rows[0].n,0,'uploads never charge');
    // Only unused uploads can be removed; the immutable version row keeps sequence numbers stable.
    const beforeDelete=await ok('GET',path);
    assert.equal((await send('DELETE',`${path}/materials/${second.material_id}`)).statusCode,409,'current source is protected');
    assert.equal((await send('DELETE',`${path}/materials/${first.material_id}`)).statusCode,204);
    assert.equal((await send('DELETE',`${path}/materials/${first.material_id}`)).statusCode,204,'repeat deletion is idempotent');
    assert.equal((await ok('GET',path)).draft_revision,beforeDelete.draft_revision+1);
    assert.equal((await ok('GET',vpath)).versions.length,1);
    assert.equal((await send('GET',`${path}/materials/${first.material_id}/download`)).statusCode,404);
    assert.equal((await send('POST',vpath+'/current',{request_id:randomUUID(),expected_selection_revision:4,version_id:selected.current_version_id})).statusCode,404);
    const mistake=await create('update'),mistakePath=`/api/v1/projects/${mistake.project_id}`;
    const wrong=await upload(mistake.project_id,'mistaken-first-upload');
    const unsel=await ok('GET',mistakePath+'/prospectus-versions');
    assert.equal(unsel.current_version_id,unsel.versions[0].version_id);assert.deepEqual(unsel.inactive_material_ids,[]);
    assert.equal(unsel.versions[0].delete_block_reason,null);
    const mistakeDraft=await ok('GET',mistakePath);
    const wrongInput={draft_revision:mistakeDraft.draft_revision,prospectus_selection_revision:1,material_versions:[{material_id:wrong.material_id,material_version:1}],requirement_message_ids:[]};
    const omittedSource=await send('POST',mistakePath+'/input-revisions',{...wrongInput,material_versions:[]});
    assert.equal(omittedSource.statusCode,409,'an uploaded but unselected source must not silently become a new-document task');
    assert.match(omittedSource.body,/当前募集书版本/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1',[mistake.project_id])).rows[0].n,0);
    owner=`other-${randomUUID()}`;assert.equal((await send('DELETE',`${mistakePath}/materials/${wrong.material_id}`)).statusCode,404);owner=user;
    assert.equal((await send('DELETE',`${mistakePath}/materials/${wrong.material_id}`)).statusCode,204);
    assert.equal((await ok('GET',mistakePath+'/prospectus-versions')).versions.length,0);
    const emptyDraft=await ok('GET',mistakePath);
    const noReference=await send('POST',mistakePath+'/input-revisions',{...wrongInput,draft_revision:emptyDraft.draft_revision,prospectus_selection_revision:2,material_versions:[]});
    assert.equal(noReference.statusCode,422,'a deleted source cannot become a source-free new task');
    assert.equal(noReference.json().field_errors[0].code,'SOURCE_PROSPECTUS_REQUIRED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1',[mistake.project_id])).rows[0].n,0);
    const replacement=await upload(mistake.project_id,'correct-replacement');
    const replaced=await ok('GET',mistakePath+'/prospectus-versions');
    assert.equal(replaced.versions[0].sequence,2);assert.equal(replaced.versions[0].material_id,replacement.material_id);
    assert.equal(replaced.current_version_id,replaced.versions[0].version_id);
    let autoDraft=await ok('GET',mistakePath);
    autoDraft=await ok('PATCH',mistakePath,{update_details:{...autoDraft.update_details,source_prospectuses:[{...source,material_id:replacement.material_id,sha256:replacement.sha256,relation:'similar_business'}]}},{'if-match':String(autoDraft.draft_revision)});
    const autoInput=await ok('POST',mistakePath+'/input-revisions',{draft_revision:autoDraft.draft_revision,prospectus_selection_revision:replaced.selection_revision,material_versions:[{material_id:replacement.material_id,material_version:1}],requirement_message_ids:[]});
    const autoManifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[mistake.project_id,autoInput.input_revision])).rows[0].manifest;
    assert.equal(autoManifest.authoring.source_prospectuses[0].material_id,replacement.material_id);
    assert.equal(autoManifest.authoring.source_prospectuses[0].relation,'similar_business');
    assert.equal(autoManifest.authoring.format_policy.template.material_id,replacement.material_id);
    assert.notEqual(autoManifest.authoring.format_policy.mode,'new_document');
    const newer=await upload(mistake.project_id,'another-source');
    const beforeReuse=await ok('GET',mistakePath+'/prospectus-versions');
    const reused=await upload(mistake.project_id,'correct-replacement');
    assert.equal(reused.material_id,replacement.material_id,'fresh identical uploads reuse bytes');
    const afterReuse=await ok('GET',mistakePath+'/prospectus-versions');
    assert.equal(afterReuse.current_version_id,replaced.current_version_id,'fresh identical upload still expresses a new source choice');
    assert.equal(afterReuse.selection_revision,beforeReuse.selection_revision+1);
    await ok('POST',`${mistakePath}/materials/uploads/${newer.upload_id}/complete`,{byte_size:newer.byte_size,sha256:newer.sha256});
    assert.deepEqual(await ok('GET',mistakePath+'/prospectus-versions'),afterReuse,'replaying the other completed upload never changes that choice');
    autoDraft=await ok('GET',mistakePath);
    await ok('PATCH',mistakePath,{update_details:{...autoDraft.update_details,format_template:{material_id:newer.material_id,material_version:1,sha256:newer.sha256}}},{'if-match':String(autoDraft.draft_revision)});
    await upload(mistake.project_id,'correct-replacement');
    assert.equal((await ok('GET',mistakePath)).update_details.format_template,undefined,'fresh upload reasserts the original even when it reuses the current material');
    assert.equal((await ok('GET',mistakePath+'/prospectus-versions')).selection_revision,afterReuse.selection_revision+1);

    // Real queue, storage, settlement and delivery, with explicitly synthetic Word output (no model).
    await publishPrices(pool,{id:'update-e2e-prices',prices:INITIAL_FIXED_PRICES,effectiveAt:'2020-01-01T00:00:00Z',actor:'test',reason:'synthetic'});
    await transaction(pool,c=>grantCredits(c,{owner:user,points:1000000,key:randomUUID(),source:'purchase',expiresAt:null,actor:'test',reason:'synthetic'}));

    // A prepared input (including an assistant card) must not bypass adoption
    // when an original is subsequently uploaded in another browser tab.
    const staleExecute={execution_request_id:randomUUID(),project_id:mistake.project_id,
      input_revision:autoInput.input_revision,input_hash:autoInput.input_hash,task_kind:'update',
      input_manifest_ref:autoInput.input_hash,storage_origin:'cloud',workspace_id:mistake.project_id};
    const staleResult=await send('POST','/api/v1/runs/execute',staleExecute);
    assert.equal(staleResult.statusCode,409,staleResult.body);
    assert.match(staleResult.body,/当前原稿已变化/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[mistake.project_id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations c JOIN bb_runs r ON r.id=c.run_id WHERE r.project_id=$1',[mistake.project_id])).rows[0].n,0,'rejection must not reserve credits');

    // An accepted task replays even if its source changes afterwards.
    const newDraft=await create('update'),newPath=`/api/v1/projects/${newDraft.project_id}`;
    const newSource=await upload(newDraft.project_id,'accepted-source');
    let newDetails=await ok('GET',newPath);
    newDetails=await ok('PATCH',newPath,{update_details:{...newDetails.update_details,source_prospectuses:[{...source,material_id:newSource.material_id,sha256:newSource.sha256}]}},{'if-match':String(newDetails.draft_revision)});
    const newInput=await ok('POST',`${newPath}/input-revisions`,{draft_revision:newDetails.draft_revision,
      prospectus_selection_revision:1,material_versions:[{material_id:newSource.material_id,material_version:1}],requirement_message_ids:[]});
    const newQuote=await ok('POST',`${newPath}/credit-quote`,{input_revision:newInput.input_revision,input_hash:newInput.input_hash});
    const newRequest={execution_request_id:randomUUID(),project_id:newDraft.project_id,input_revision:newInput.input_revision,
      input_hash:newInput.input_hash,task_kind:'update',input_manifest_ref:newInput.input_hash,storage_origin:'cloud',
      workspace_id:newDraft.project_id,quote_id:newQuote.quote.quote_id};
    const accepted=await ok('POST','/api/v1/runs/execute',newRequest);
    await upload(newDraft.project_id,'uploaded-after-accepted-run');
    assert.equal((await ok('POST','/api/v1/runs/execute',newRequest)).run_id,accepted.run_id,'existing run keeps its locked input and reservation');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[newDraft.project_id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations c JOIN bb_runs r ON r.id=c.run_id WHERE r.project_id=$1',[newDraft.project_id])).rows[0].n,1);
    await ok('POST',`/api/v1/runs/${accepted.run_id}/cancel`,{reason:'synthetic_cleanup'});

    const execute=async(i:any)=>{
      const quote=await ok('POST',`${path}/credit-quote`,{input_revision:i.input_revision,input_hash:i.input_hash});
      return ok('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:p.project_id,input_revision:i.input_revision,input_hash:i.input_hash,task_kind:'update',input_manifest_ref:i.input_hash,storage_origin:'cloud',workspace_id:p.project_id,quote_id:quote.quote.quote_id});
    };
    const complete=async(r:any)=>{
      const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,r.run_id);
      const revision=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic tracked output'}),blobs,'generated_pair_v1');
      const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic clean output'}),blobs,'generated_pair_v1');
      const pair={revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId};
      await checkpointStage(pool,lease,'word_delivery_pair',pair);
      assert.equal((await finish(pool,lease,'succeeded',{artifactId:revision.artifactId,artifactVersion:1,blobs})).state,'succeeded');
      const savedRun=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.run_id])).rows[0];
      await transaction(pool,c=>registerGeneratedProspectus(c,savedRun,pair)); // completion replay
      for(const id of [revision.artifactId,clean.artifactId]){
        const meta=await ok('GET',`/api/v1/artifacts/${id}`);
        const response=await send('GET',meta.download_url);
        assert.equal(response.statusCode,200);assert.equal(digest(response.rawPayload),meta.sha256);
      }
      return clean;
    };
    const refreshedProject=await ok('GET',path);
    const refreshedInput=await ok('POST',`${path}/input-revisions`,{...input,draft_revision:refreshedProject.draft_revision});
    assert.deepEqual((await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[p.project_id,locked.input_revision])).rows[0].manifest,snapshot,'deletion preserves the old immutable snapshot');
    const run=await execute(refreshedInput),clean=await complete(run);
    const generated=await ok('GET',vpath);
    assert.equal(generated.versions.length,2,'completion replay creates no duplicate');
    assert.equal((await send('DELETE',`${path}/materials/${second.material_id}`)).statusCode,409,'old task source remains protected after current changes');
    assert.equal(generated.versions.find((v:any)=>v.version_id===generated.current_version_id).artifact_id,clean.artifactId);
    const laterFormat=await upload(p.project_id,'later-format-reference','reference');
    project=await ok('GET',path);
    project=await ok('PATCH',path,{update_details:{...project.update_details,
      format_template:{material_id:laterFormat.material_id,material_version:1,sha256:laterFormat.sha256}}},{'if-match':String(project.draft_revision)});
    const next=await ok('POST',`${path}/input-revisions`,{...input,draft_revision:project.draft_revision,prospectus_selection_revision:generated.selection_revision});
    const nextManifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[p.project_id,next.input_revision])).rows[0].manifest;
    assert.equal(nextManifest.authoring.previous_output.artifact_id,clean.artifactId,'repeat update pins current generated clean version');
    assert.deepEqual(nextManifest.authoring.format_policy,{version:'source-format-v1',mode:'preserve_docx',
      template:{kind:'artifact',...nextManifest.authoring.previous_output},selection:'previous_output'},'continuation inherits exact clean-result format');
    assert.equal(nextManifest.update_details.format_template.material_id,laterFormat.material_id,'continuation does not mutate the saved draft choice');
    const running=await execute(next),third=await upload(p.project_id,'v3-during-run');
    const uploaded=await ok('GET',vpath);
    assert.equal(uploaded.versions.find((v:any)=>v.version_id===uploaded.current_version_id).material_id,third.material_id,'upload automatically changes the next baseline during an existing run');
    await complete(running);
    const raced=await ok('GET',vpath);
    assert.equal(raced.current_version_id,uploaded.current_version_id,'older task completion cannot overwrite newer upload');
    assert.equal(raced.versions.length,4,'generated output remains in history');

    // Upgrade backfill is repeatable and leaves explicitly selected versions unchanged.
    const legacy=await create('review'),legacyMaterial=await upload(legacy.project_id,'legacy');
    await pool.query("UPDATE bb_projects SET kind='update' WHERE id=$1",[legacy.project_id]);
    const migration=await readFile(new URL('../../../db/migrations/0108_backfill_prospectus_versions.sql',import.meta.url),'utf8');
    await pool.query(migration);await pool.query(migration);
    const legacyVersions=await ok('GET',`/api/v1/projects/${legacy.project_id}/prospectus-versions`);
    assert.equal(legacyVersions.versions.length,1);assert.equal(legacyVersions.versions[0].material_id,legacyMaterial.material_id);
    assert.equal((await ok('GET',vpath)).current_version_id,uploaded.current_version_id);
    owner=`other-${randomUUID()}`;
    assert.equal((await send('GET',vpath)).statusCode,404);
    assert.equal((await send('POST',`${path}/update-workspace`,{})).statusCode,404);
    assert.equal((await send('POST',vpath,selection)).statusCode,404);
  }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
