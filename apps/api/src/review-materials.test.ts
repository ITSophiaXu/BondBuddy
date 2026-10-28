// Synthetic project data; real PostgreSQL and API routes, no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';

const connection=await isolatedTestDatabase(undefined,'review-materials');
test('QA and file-generation task inputs stay out of review display, legacy drafts, execution and linked copies; factual evidence remains', {skip:!connection}, async()=>{
  const pool=new Pool({connectionString:connection}),owner='synthetic-review-materials',origin='http://bondbuddy.test';
  const app=createServer({pool,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  const ok=(r:{statusCode:number;body:string})=>assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);
  try{
    const created=await send('POST','/api/v1/projects',{name:'Synthetic review materials',kind:'review',issuer_name:null,market:null,offering:null});ok(created);
    const id=created.json().project_id,base=`/api/v1/projects/${id}`;
    const material=async(role:string,name:string,projectId=id)=>{
      const mat=uid(),upload=uid(),sha=digest(mat);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,$4,'application/pdf',16,$5,$6,$7,now()+interval '1 hour','completed')`,[upload,owner,projectId,name,sha,role,`synthetic/${upload}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,$6,'application/pdf',16,$7,$8,'persisted')`,[mat,owner,projectId,upload,role,name,sha,`synthetic/${mat}`]);
      return {material_id:mat,material_version:1,sha256:sha};
    };
    const source=await material('historical','合成募集书.pdf'),question=await material('other','质控部问题.pdf'),evidence=await material('other','质控部问题.pdf');
    const catalogue=await material('other','底稿目录.xlsx'),template=await material('other','生成模板.docx'),imported=await material('other','已导入的立项报告.docx');
    const workflow=[question,catalogue,template,imported];
    const legacy={source_material_ref:source,material_versions:[source,evidence,...workflow],requirements:['保留复核要求'],as_of:null,evidence_links:[]};
    ok(await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:0,input:legacy}));
    const manifest={version:'project-qa-v1',operation:'prepare',source:{filename:'质控部问题.pdf',asset:{kind:'material',pin:{...question,source_project_id:id}}},materials:[{filename:'质控部问题.pdf',asset:{kind:'material',pin:{...evidence,source_project_id:id}}}]};
    const run=uid(),hash=inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')`,[id,owner,hash,manifest]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'generation',$4,'cancelled')`,[run,owner,id,hash,uid()]);
    await pool.query(`INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,1,'prepare',$4,$5)`,[run,owner,id,manifest,hash]);
    await pool.query(`INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256)
      VALUES($1,$2,$3,$4,$5,$6,'底稿目录.xlsx','[]','[]',$5)`,[uid(),owner,id,uid(),digest('catalogue'),{...catalogue,source_project_id:id}]);
    await pool.query(`INSERT INTO bb_m4_templates(id,version,owner_user_id,document_type,name,broker,material,sha256,creation_request_id,request_hash,market)
      VALUES($1,1,$2,'init','合成模板','合成券商',$3,$4,$5,$4,'sse')`,[uid(),owner,{...template,source_project_id:id},digest('template'),uid()]);
    const family=uid();
    await pool.query(`INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type) VALUES($1,$2,$3,'init')`,[family,owner,id]);
    await pool.query(`INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset) VALUES($1,$2,$3,1,'已导入的立项报告.docx',$4)`,[uid(),owner,family,{kind:'material',pin:{...imported,source_project_id:id}}]);
    const workspace=await send('GET',`${base}/review-workspace`);ok(workspace);
    assert.deepEqual(new Set(workspace.json().materials.map((m:any)=>m.material_id)),new Set([source.material_id,evidence.material_id]));
    assert.deepEqual(workspace.json().draft.material_versions,[source,evidence]);
    assert.deepEqual((await send('GET',`${base}/review-draft`)).json().draft.requirements,legacy.requirements);
    for(const blocked of workflow)assert.equal((await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:1,input:{...legacy,material_versions:[source,evidence,blocked]}})).statusCode,422);
    const executed=await send('POST',`${base}/review-executions`,{execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]});ok(executed);
    const snapshot=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[id,executed.json().input_revision])).rows[0].manifest;
    assert.deepEqual(snapshot.materials.map((m:any)=>m.material_id),[source.material_id,evidence.material_id]);
    assert.deepEqual((await pool.query('SELECT input FROM bb_review_drafts WHERE project_id=$1',[id])).rows[0].input,legacy,'GET and execution do not rewrite stored legacy input');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE id=ANY($1::text[]) AND deleted_at IS NULL',[workflow.map(p=>p.material_id)])).rows[0].n,4);
    assert.deepEqual((await pool.query('SELECT manifest FROM bb_project_qa_runs WHERE run_id=$1',[run])).rows[0].manifest,manifest);
    const linked=await send('POST','/api/v1/projects',{name:'Synthetic linked workspace',kind:'update',issuer_name:null,market:null,offering:null});ok(linked);
    const target=linked.json().project_id,copy=await material('other','复制后已重命名.pdf',target),kept=await material('other','真实核验材料.pdf',target);
    await pool.query(`INSERT INTO bb_update_workspaces(owner_user_id,source_project_id,update_project_id) VALUES($1,$2,$3)`,[owner,id,target]);
    const copiedCatalogue=await material('other','复制目录.xlsx',target),copiedTemplate=await material('other','复制模板.docx',target);
    for(const [original,copied] of [[question,copy],[evidence,kept],[catalogue,copiedCatalogue],[template,copiedTemplate]])await pool.query(`INSERT INTO bb_update_material_copies(owner_user_id,project_id,source_project_id,source_material_id,source_material_version,upload_id,material_id)
      SELECT $1,$2,$3,$4,1,m.upload_id,m.id FROM bb_material_versions m WHERE m.owner_user_id=$1 AND m.id=$5`,[owner,target,id,original.material_id,copied.material_id]);
    assert.equal((await send('POST',`${base}/review-entry`,{})).json().project_id,target);
    const copiedWorkspace=await send('GET',`/api/v1/projects/${target}/review-workspace`);ok(copiedWorkspace);
    assert.deepEqual(copiedWorkspace.json().materials.map((m:any)=>m.material_id),[kept.material_id]);
  }finally{await app.close();await pool.end();}
});
