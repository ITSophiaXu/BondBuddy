import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {ZipFile} from 'yazl';
import {createServer} from './server.js';
import {grantCredits} from './billing.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {workpaperDocx} from './workpaper-docx.js';
import {headerlessCatalogueXlsx} from './workpaper-catalogue-fixture.js';
import {storeTemplateMaterial} from './file-template-library.js';
import {readM4MaterialPin} from './m4-workspace.js';
import {readProjectFileAsset} from './project-file-storage.js';
import {qaMaterials} from './project-qa.js';
import {emptyFileGenerationPreparation,M4_DOCUMENT_FIXED_PRICE,type FileTemplateSet} from '@bondbuddy/contracts';
for(const automatic of [false,true]){
const connection=await isolatedTestDatabase(undefined,'file-generation-'+(automatic?'automatic':'legacy'));
test(`real PostgreSQL (${automatic?'automatic':'legacy'}): private import, builtin adoption, redacted previews, immutable mixed batch and rollback`,{skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection}),originalOwner='fg-'+randomUUID();let owner=originalOwner;
 const memory=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{memory.set(k,Buffer.from(b));},get:async k=>memory.get(k)!,getIfExists:async k=>memory.get(k)??null,getIfExistsBounded:async(k,max)=>{const b=memory.get(k);return b&&b.length<=max?b:null;},exists:async k=>memory.has(k),delete:async k=>{memory.delete(k);}};
 const app=createServer({pool,blobs,enableSubscriptionBilling:automatic,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true})});
 const errors:string[]=[];app.addHook('onError',async(_req,_reply,error)=>{errors.push(error.message);});
 const send=(method:string,path:string,body?:unknown)=>app.inject({method:method as any,url:path,payload:body as any,headers:{origin:'http://bondbuddy.test',...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{})}});
 const ok=async(method:string,path:string,body?:unknown)=>{const r=await send(method,path,body);assert.ok(r.statusCode<300,`${r.statusCode}: ${r.body}; ${errors.join(' | ')}`);return r.json();};
 const oldBundle=process.env.BB_FILE_TEMPLATE_BUNDLE,temporary=await mkdtemp(join(tmpdir(),'bb-template-fixture-'));
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_fg_'+randomUUID().slice(0,8)]);
  const project=(await ok('POST','/api/v1/projects',{name:'Synthetic mixed files',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'})).project_id,base=`/api/v1/projects/${project}/file-generation`;
  const word=await workpaperDocx('Secret Enterprise Sentinel',['项目名称：Secret Project','姓名：Secret Person','联系电话：13800001111','核查结论']),xlsx=await headerlessCatalogueXlsx();
  await writeFile(join(temporary,'template.docx'),word);await writeFile(join(temporary,'catalogue.xlsx'),xlsx);
  const manifest={version:'synthetic-v1',name:'光大证券模板',catalogue:{path:'catalogue.xlsx',sha256:digest(xlsx)},records:[{id:'workpaper',path:'template.docx',sha256:digest(word),name:'核查记录',code:'1',role:'核查记录',document_type:'workpaper'},{id:'annual',path:'template.docx',sha256:digest(word),name:'年度报告',code:'',role:'年度报告',document_type:'annual'}]};
  await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest));process.env.BB_FILE_TEMPLATE_BUNDLE=temporary;
  const adopted=await ok('POST',base+'/builtin',{request_id:'builtin',version:manifest.version,part:'all'});assert.equal(adopted.catalogue.entries.length,3);assert.equal(adopted.set.records.length,2);
  assert.equal((await ok('POST',base+'/builtin',{request_id:'again',version:manifest.version,part:'all'})).set.set_id,adopted.set.set_id);
  const pin=(record:any)=>({set_id:adopted.set.set_id,record_id:record.record_id,sha256:record.sha256});
  const wp=pin(adopted.set.records[0]),annual=pin(adopted.set.records[1]);
  const preview=await ok('POST',base+'/template-preview',wp);assert.equal(preview.redacted,true);assert.ok(!JSON.stringify(preview).includes('Secret'));assert.ok(!JSON.stringify(preview).includes('13800001111'));assert.ok(JSON.stringify(preview).includes('核查结论'));
  const workspace=await ok('GET',base);assert.ok(!JSON.stringify(workspace).includes('object_key'));assert.ok(!JSON.stringify(workspace).includes('Secret'));
  const requestId=randomUUID(),query=new URLSearchParams({request_id:requestId,sha256:digest(word),document_type:'workpaper',format:'docx',filename:'1 Secret Person.docx'});
  const imported=await ok('POST',base+'/templates/import?'+query,word);assert.equal(imported.records.length,1);assert.ok(!JSON.stringify(imported).includes('Secret'));
  assert.equal((await ok('POST',base+'/templates/import?'+query,word)).set_id,imported.set_id);
  owner='foreign-'+randomUUID();assert.equal((await send('GET',base)).statusCode,404);assert.equal((await send('POST',base+'/template-preview',wp)).statusCode,404);assert.equal((await send('POST',base+'/builtin',{request_id:'x',version:manifest.version,part:'all'})).statusCode,404);owner=originalOwner;
  const source=await transaction(pool,c=>storeTemplateMaterial(c,blobs,owner,project,word,'Synthetic prospectus.docx')),version=randomUUID();
  await pool.query("INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version) VALUES($1,$2,$3,1,'upload','Synthetic prospectus.docx',$4,$5,1)",[version,owner,project,source.sha256,source.material_id]);
  await pool.query('INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)',[owner,project,version]);
  const prep={...emptyFileGenerationPreparation(),document_types:['workpaper','annual'],catalogue_id:adopted.catalogue.catalogue_id,template_set_id:adopted.set.set_id,item_ids:[adopted.catalogue.entries[0].id],mappings:{[adopted.catalogue.entries[0].id]:wp},document_templates:{annual},target_year:'2026'};
  const saved=await ok('PUT',base+'/preparation',{expected_revision:0,preparation:prep});assert.equal(saved.revision,1);assert.equal((await ok('PUT',base+'/preparation',{expected_revision:0,preparation:prep})).revision,1);
  assert.equal((await send('PUT',base+'/preparation',{expected_revision:0,preparation:{...prep,requirements:'stale'}})).statusCode,409);
  let request:import('@bondbuddy/contracts').FileGenerationSubmit={request_id:randomUUID(),expected_revision:1,source_version_id:version,source_selection_revision:1,expected_points:9000,price_version:M4_DOCUMENT_FIXED_PRICE.version};
  const quoted=await ok('POST',base+'/quote',request);assert.equal(quoted.count,2);assert.equal(quoted.omitted.length,2);
  const grant=async(points:number)=>transaction(pool,c=>grantCredits(c,{owner,points,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'isolated mixed billing regression'}));
  if(automatic){
   assert.equal(workspace.pricing.mode,'automatic');assert.equal(workspace.pricing.workpaper_points,3458);assert.equal(workspace.pricing.document_points,7965);
   assert.equal(quoted.points,11423);assert.equal(quoted.auto_charge,true);
   request={...request,expected_points:quoted.points,price_version:quoted.price_version,document_quotes:quoted.documents.map((d:any)=>({document_type:d.document_type,draft_version:d.draft_version,scope_quote_id:d.scope_quote_id}))};
   const repeated=await ok('POST',base+'/quote',request);assert.deepEqual(repeated.documents.map((d:any)=>[d.draft_version,d.scope_quote_id]),quoted.documents.map((d:any)=>[d.draft_version,d.scope_quote_id]),'quote retry pins the same drafts and scopes');
   await grant(7965); // enough for either child, insufficient for their combined scope
   assert.equal((await send('POST',base+'/batches',request)).statusCode,402);
   for(const table of ['bb_file_generation_batches','bb_workpaper_batches','bb_project_file_batches','bb_scope_acceptances','bb_credit_reservations'])assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,table+' must remain empty after insufficient funds');
   await grant(3458);
  }
  const adoptionsBefore=(await pool.query('SELECT count(*)::int n FROM bb_file_template_adoptions')).rows[0].n;
  assert.equal((await send('POST',base+'/batches',{...request,expected_points:4500})).statusCode,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_file_generation_batches')).rows[0].n,0);
  // Force a failure after the workpaper child has been prepared; neither child survives.
  await pool.query(`CREATE FUNCTION bb_test_fail_document_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$;
   CREATE TRIGGER bb_test_fail_document_batch BEFORE INSERT ON bb_project_file_batches FOR EACH ROW EXECUTE FUNCTION bb_test_fail_document_batch();`);
  assert.equal((await send('POST',base+'/batches',request)).statusCode,500);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_batches')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_file_template_adoptions')).rows[0].n,adoptionsBefore);
  await pool.query('DROP TRIGGER bb_test_fail_document_batch ON bb_project_file_batches; DROP FUNCTION bb_test_fail_document_batch()');
  const results=await Promise.all([ok('POST',base+'/batches',request),ok('POST',base+'/batches',request)]);assert.equal(results[0].batch_id,results[1].batch_id);assert.ok(results[0].workpapers);assert.ok(results[0].documents);
  if(automatic){
   assert.equal(results[0].points,11423);
   assert.equal((await pool.query('SELECT count(*)::int n FROM bb_scope_acceptances')).rows[0].n,1,'one document scope accepted across concurrent replay');
   const child=(await pool.query('SELECT items FROM bb_project_file_batches WHERE id=$1',[results[0].documents.batch_id])).rows[0].items[0];
   assert.equal(child.points,7965);assert.ok(child.scope_acceptance_id);
   const workpaper=(await pool.query('SELECT total_points,price_version FROM bb_workpaper_batches WHERE id=$1',[results[0].workpapers.batch_id])).rows[0];
   assert.equal(workpaper.price_version,request.price_version);assert.equal(Number(workpaper.total_points),3458);
  }
  const task=(await pool.query('SELECT manifest FROM bb_workpaper_items WHERE batch_id=$1',[results[0].workpapers.batch_id])).rows[0].manifest;
  assert.equal(task.input.workpaper.execution,undefined,'must use original Word editing path, never body-rebuilding shared renderer');assert.equal(task.template_material.sha256,digest(word));assert.equal(task.input.template.sha256,digest(word));
  const stored=(await pool.query('SELECT * FROM bb_material_versions WHERE id=$1',[task.template_material.material_id])).rows[0];assert.equal(digest(memory.get(stored.object_key)!),digest(word),'the selected original is preserved byte for byte');
  assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${stored.id}/download?version=1`)).statusCode,404,'internal originals cannot bypass the redacted preview');
  await assert.rejects(()=>readM4MaterialPin(pool,owner,task.template_material));
  await assert.rejects(()=>readProjectFileAsset(pool,owner,{kind:'material',pin:task.template_material}));
  assert.ok(!(await qaMaterials(pool,owner,project)).some(m=>m.asset.kind==='material'&&m.asset.pin.material_id===stored.id),'template originals are not project evidence');
  const abandoned={...request,request_id:randomUUID()};assert.equal((await ok('POST',base+'/stop-submission',abandoned)).batch,null);assert.equal((await send('POST',base+'/batches',abandoned)).statusCode,409,'a delayed retry cannot create a cancelled submission');
  await ok('PUT',base+'/preparation',{expected_revision:1,preparation:{...prep,requirements:'new preparation'}});
  assert.equal((await ok('POST',base+'/batches',request)).batch_id,results[0].batch_id,'receipt replays before consulting the changed preparation');
  assert.equal((await send('POST',base+'/batches',{...request,expected_revision:2})).statusCode,409);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[owner])).rows[0].n,automatic?2:0,'preparation and task submission do not fake a charge');
 }finally{if(oldBundle===undefined)delete process.env.BB_FILE_TEMPLATE_BUNDLE;else process.env.BB_FILE_TEMPLATE_BUNDLE=oldBundle;await app.close();await pool.end();if(relative(resolve(tmpdir()),resolve(temporary)).startsWith('bb-template-fixture-'))await rm(temporary,{recursive:true,force:true});}
});

}
