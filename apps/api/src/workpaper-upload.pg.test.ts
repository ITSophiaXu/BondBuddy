import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from './server.js';
import {azureBlobs,digest} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {headerlessCatalogueXlsx} from './workpaper-catalogue-fixture.js';

const connection=await isolatedTestDatabase(undefined,'workpaper-upload');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('real upload and catalogue persistence accept headerless XLSX, replay once, and preserve owner isolation',{skip:!connection||!storage},async()=>{
  const pool=new Pool({connectionString:connection}),originalOwner='catalogue-'+randomUUID();let owner=originalOwner;
  const container='bb-catalogue-'+randomUUID().replaceAll('-',''),blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode}: ${r.body}`);return r.statusCode===204?null:r.json();};
  try{
    const project=(await ok('POST','/api/v1/projects',{name:'Synthetic catalogue test',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'})).project_id;
    const bytes=process.env.BB_TEST_WORKPAPER_XLSX?readFileSync(process.env.BB_TEST_WORKPAPER_XLSX):await headerlessCatalogueXlsx();
    const declaration={filename:'合成目录.xlsx',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',role:'other',byte_size:bytes.length,sha256:digest(bytes)};
    const upload=await ok('POST',`/api/v1/projects/${project}/materials/uploads`,declaration);
    await ok('PUT',upload.upload_url,bytes);
    const material=await ok('POST',`/api/v1/projects/${project}/materials/uploads/${upload.upload_id}/complete`,{byte_size:bytes.length,sha256:declaration.sha256});
    const request={request_id:randomUUID(),material:{source_project_id:project,material_id:material.material_id,material_version:material.material_version,sha256:material.sha256}};
    const url=`/api/v1/projects/${project}/workpapers/catalogues`,catalogue=await ok('POST',url,request);
    assert.equal(catalogue.entries.length,Number(process.env.BB_TEST_WORKPAPER_EXPECTED_ITEMS??3));
    assert.equal(catalogue.entries[0].code,'1');assert.equal(catalogue.entries[0].row,2);
    assert.equal((await ok('POST',url,request)).catalogue_id,catalogue.catalogue_id);
    assert.equal((await ok('GET',`/api/v1/projects/${project}/workpapers`)).catalogues.length,1);
    const downloaded=await send('GET',`/api/v1/projects/${project}/materials/${material.material_id}/download?version=1`);
    assert.equal(digest(downloaded.rawPayload),declaration.sha256);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,0,'import must not start a generation run');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[owner])).rows[0].n,0,'import must not charge credits');
    owner='foreign-'+randomUUID();assert.equal((await send('POST',url,request)).statusCode,404);
  }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
