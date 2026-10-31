import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'prospectus-auto-adoption');
test('automatic adoption migration repairs missing baselines without rewriting inputs or valid continuations',{skip:!connection},async()=>{
  const db=new Pool({connectionString:connection});
  const owner='synthetic-auto-migration',sha='a'.repeat(64),docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const migration=await readFile(new URL('../../../db/migrations/0162_automatic_prospectus_upload_adoption.sql',import.meta.url),'utf8');
  try{
    await db.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)',[owner,'+8613888888822']);
    for(const scenario of ['pending','broken-first-draft','valid-continuation','valid-unregistered-continuation','selected-upload','review']){
      const p='auto-'+scenario,m=p+'-material',upload=p+'-upload',version=p+'-source';
      await db.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,update_details) VALUES($1,$2,'Synthetic automatic adoption',$3,$4)`,
        [p,owner,scenario==='review'?'review':'update',{authoring_mode:'unified_v1'}]);
      await db.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'synthetic.docx',$4,10,$5,'historical',$1,now()+interval '1 hour','completed',$5,10)`,[upload,owner,p,docx,sha]);
      await db.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic.docx',$5,10,$6,$1,'persisted')`,[m,owner,p,upload,docx,sha]);
      // The pending fixture predates version registration and exercises backfill too.
      if(scenario!=='pending'&&scenario!=='valid-unregistered-continuation')await db.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version)
        VALUES($1,$2,$3,1,'upload','synthetic.docx',$4,$5,1)`,[version,owner,p,sha,m]);
      if(scenario==='selected-upload')await db.query('INSERT INTO bb_prospectus_selection VALUES($1,$2,$3,3)',[owner,p,version]);
      if(scenario==='broken-first-draft'||scenario.includes('continuation')){
        const run=p+'-run',artifact=p+'-artifact',generated=p+'-generated';
        const materials=scenario.includes('continuation')?[{material_id:m,material_version:1,role:'historical',sha256:sha}]:[];
        const manifest={materials,authoring:{source_prospectuses:materials,format_policy:{mode:materials.length?'preserve_docx':'new_document'}}};
        await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
          VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[p,owner,sha,manifest,JSON.stringify(materials)]);
        await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,artifact_id)
          VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued',$5)`,[run,owner,p,sha,artifact]);
        await db.query(`INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
          VALUES($1,$2,$3,$1,1,$4,10,'synthetic','passed','available','readback_verified',$4,10,$5)`,[artifact,owner,run,sha,{sha256:sha,byte_size:10,validator_version:'synthetic',quality_status:'passed'}]);
        await db.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
          VALUES($1,1,$2,$3,$4,$5,$1,'passed','available',$1)`,[artifact,owner,run,docx,sha]);
        await db.query("UPDATE bb_runs SET state='succeeded',artifact_version=1 WHERE id=$1",[run]);
        await db.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,artifact_id,artifact_version,run_id)
          VALUES($1,$2,$3,2,'generated','synthetic-result.docx',$4,$5,1,$6)`,[generated,owner,p,sha,artifact,run]);
        await db.query('INSERT INTO bb_prospectus_selection VALUES($1,$2,$3,1)',[owner,p,generated]);
      }
    }
    const originals=(await db.query('SELECT * FROM bb_input_revisions ORDER BY project_id')).rows;
    await db.query(migration);
    const selections=(await db.query('SELECT project_id,version_id,revision FROM bb_prospectus_selection ORDER BY project_id')).rows;
    const selected=(name:string)=>selections.find(s=>s.project_id==='auto-'+name);
    assert.equal(selected('pending').version_id,'auto-upload:auto-pending-material:1');
    assert.equal(selected('broken-first-draft').version_id,'auto-broken-first-draft-source');
    assert.equal(selected('broken-first-draft').revision,2);
    assert.equal(selected('valid-continuation').version_id,'auto-valid-continuation-generated');
    assert.equal(selected('valid-continuation').revision,1);
    assert.equal(selected('valid-unregistered-continuation').version_id,'auto-valid-unregistered-continuation-generated');
    assert.equal(selected('valid-unregistered-continuation').revision,1);
    assert.equal(selected('selected-upload').revision,3);
    assert.equal(selected('review'),undefined);
    await db.query(migration);
    assert.deepEqual((await db.query('SELECT project_id,version_id,revision FROM bb_prospectus_selection ORDER BY project_id')).rows,selections);
    assert.deepEqual((await db.query('SELECT * FROM bb_input_revisions ORDER BY project_id')).rows,originals);
    assert.equal((await db.query("SELECT count(*)::int n FROM bb_outbox WHERE event_type='prospectus.current_changed'")).rows[0].n,2);
  }finally{await db.end();}
});
