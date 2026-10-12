import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {runtime,databaseURL,blobConnection} from './config.mjs';

const projectId='53a40522-9188-4e31-99f9-0efaf743353f';
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
const container=BlobServiceClient.fromConnectionString(blobConnection).getContainerClient('bondbuddy-private');
try{
  const project=(await pool.query('SELECT p.id,p.name,u.username FROM bb_projects p JOIN bb_users u ON u.id=p.owner_user_id WHERE p.id=$1',[projectId])).rows[0];
  assert.equal(project.username,'integration_user');
  const materials=(await pool.query('SELECT filename,object_key,sha256,byte_size FROM bb_material_versions WHERE project_id=$1 AND deleted_at IS NULL ORDER BY filename',[projectId])).rows;
  assert.equal(materials.length,2);
  const verified=[];
  for(const row of materials){
    const bytes=await container.getBlockBlobClient(row.object_key).downloadToBuffer();
    assert.equal(bytes.length,Number(row.byte_size));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);
    verified.push({filename:row.filename,bytes:bytes.length,sha256:row.sha256});
  }
  const accounts=(await pool.query("SELECT username FROM bb_users WHERE username IN ('integration_user','integration_low') ORDER BY username")).rows;
  assert.equal(accounts.length,2);
  const proof={checkedAt:new Date().toISOString(),passed:true,project,accounts,materials:verified};
  writeFileSync(join(runtime,'saved-sample-console-recovery.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof,null,2));
}finally{await pool.end();}
