import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from './server.js';
import {azureBlobs,digest,type PrivateBlobs} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {workpaperDocx} from './workpaper-docx.js';
import {headerlessCatalogueXlsx} from './workpaper-catalogue-fixture.js';

const database=await isolatedTestDatabase(undefined,'file-template-loading');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('real PostgreSQL/Azurite: 147 templates retain order, deduplicate assets, preview, rollback and retry',{skip:!database||!storage,timeout:180000},async t=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),container='bb-templates-'+randomUUID().replaceAll('-','');
 const raw=azureBlobs(storage!,container),temporary=await mkdtemp(join(tmpdir(),'bb-template-loading-')),oldBundle=process.env.BB_FILE_TEMPLATE_BUNDLE;
 let writes=0,active=0,peak=0,corrupt=true;
 const blobs:PrivateBlobs={...raw,put:async(k,b,m)=>{writes++;active++;peak=Math.max(peak,active);try{await delay(5);await raw.put(k,b,m);}finally{active--; }},getIfExistsBounded:async(k,max)=>{const b=await raw.getIfExistsBounded(k,max);return corrupt&&k.includes('/file-templates/')?Buffer.from('corrupt'):b;}};
 const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true})});
 const post=(path:string,payload:unknown)=>app.inject({method:'POST',url:'/api/v1'+path,payload:payload as any,headers:{origin:'http://bondbuddy.test'}});
 try{
  const p=await post('/projects',{name:'Synthetic template scale',kind:'generation',issuer_name:'Synthetic',market:'sse',offering:'private'});assert.equal(p.statusCode,201,p.body);
  const project=p.json().project_id,base=`/projects/${project}/file-generation`;
  const catalogue=await headerlessCatalogueXlsx(Array.from({length:248},(_,i)=>['1-'+i,'合成核查记录 '+i]));
  await writeFile(join(temporary,'catalogue.xlsx'),catalogue);
  const records=[];
  for(let i=0;i<147;i++){
   const bytes=await workpaperDocx('Secret Enterprise '+i,['项目名称：Secret Project','核查结论 '+i]),path=i+'.docx';
   await writeFile(join(temporary,path),bytes);records.push({id:'record-'+i,path,sha256:digest(bytes),name:'核查记录 '+i,code:'1-'+i,role:'核查记录',document_type:'workpaper'});
  }
  records.push({...records[0],id:'duplicate-role',name:'重复字节的另一角色',role:'发行人说明'});
  const manifest={version:'synthetic-scale-v1',name:'光大证券模板',catalogue:{path:'catalogue.xlsx',sha256:digest(catalogue)},records};
  await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest));process.env.BB_FILE_TEMPLATE_BUNDLE=temporary;
  const request={request_id:randomUUID(),version:manifest.version,part:'all'};
  const failed=await post(base+'/builtin',request);assert.equal(failed.statusCode,500);assert.equal(active,0,'all in-flight writes settle before rollback');
  for(const table of ['bb_file_template_sets','bb_workpaper_catalogues'])assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_user_id=$1`,[owner])).rows[0].n,0,'no partial '+table);
  corrupt=false;writes=0;peak=0;const start=performance.now();
  const response=await post(base+'/builtin',request);assert.equal(response.statusCode,200,response.body);
  const result=response.json(),elapsed=performance.now()-start;
  assert.equal(result.catalogue.entries.length,248);assert.equal(result.set.records.length,148);assert.ok(peak>1&&peak<=4);assert.equal(active,0);
  assert.deepEqual(result.set.records.map((r:any)=>r.record_id),records.map(r=>r.id));
  assert.deepEqual(result.set.records.map((r:any)=>r.sha256),records.map(r=>r.sha256));
  assert.equal(writes,148,'147 distinct Word assets plus one catalogue upload');
  for(const record of [result.set.records[0],result.set.records[146],result.set.records[147]]){
   const preview=await post(base+'/template-preview',{set_id:result.set.set_id,record_id:record.record_id,sha256:record.sha256});
   assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().redacted,true);assert.ok(!preview.body.includes('Secret'));
  }
  const repeat=await post(base+'/builtin',{...request,request_id:randomUUID()});assert.equal(repeat.statusCode,200,repeat.body);assert.equal(repeat.json().set.set_id,result.set.set_id);assert.equal(writes,148);
  t.diagnostic(JSON.stringify({syntheticTemplates:147,records:148,catalogueEntries:248,peakBlobWrites:peak,loadMs:Math.round(elapsed)}));
 }finally{
  if(oldBundle===undefined)delete process.env.BB_FILE_TEMPLATE_BUNDLE;else process.env.BB_FILE_TEMPLATE_BUNDLE=oldBundle;
  await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();await rm(temporary,{recursive:true,force:true});
 }
});
