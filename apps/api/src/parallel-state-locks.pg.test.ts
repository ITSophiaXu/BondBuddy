import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {digest,project,type PrivateBlobs} from './data.js';
import {savePromptSnapshot} from './log-ops.js';
import {saveSnapshotRef} from './observability.js';
import {isolatedTestDatabase} from './test-database.js';
const database=await isolatedTestDatabase(undefined,'parallel-state-locks');

test('a gated prompt readback does not serialize sibling reads; versions remain unique and bad hashes cannot bypass verification',
 {skip:!database,timeout:15000},async()=>{
 const pool=new Pool({connectionString:database,max:8}),owner=randomUUID(),id=randomUUID(),objects=new Map<string,Buffer>();
 let firstReadResolve!:()=>void,allReadResolve!:()=>void,releaseRead!:()=>void,reads=0;
 const firstRead=new Promise<void>(resolve=>{firstReadResolve=resolve;}),allRead=new Promise<void>(resolve=>{allReadResolve=resolve;}),released=new Promise<void>(resolve=>{releaseRead=resolve;});
 const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>{
  const value=objects.get(k)!;
  if(value.toString().startsWith('parallel-prompt-')){reads++;if(reads===4)allReadResolve();if(value.toString()==='parallel-prompt-0'){firstReadResolve();await released;}}
  return value.toString()==='bad-prompt'?Buffer.from('wrong bytes'):Buffer.from(value);
 },getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,n)=>{const bytes=objects.get(k);return bytes&&bytes.length<=n?bytes:null;},delete:async k=>{objects.delete(k);},exists:async k=>objects.has(k)};
 let calls:Promise<string>[]=[];
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'lock_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,kind,name) VALUES($1,$2,'generation','Synthetic prompt locks')",[id,owner]);
  calls=[savePromptSnapshot(pool,blobs,{owner,projectId:id,kind:'model_request',body:'parallel-prompt-0'})];
  await firstRead;
  for(let i=1;i<4;i++)calls.push(savePromptSnapshot(pool,blobs,{owner,projectId:id,kind:'model_request',body:'parallel-prompt-'+i}));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([allRead,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Sibling Blob reads were blocked by the version lock')),2000);})]);}
  finally{clearTimeout(timer);releaseRead();}
  const refs=await Promise.all(calls);assert.equal(reads,4);
  const rows=(await pool.query('SELECT version,object_key,content_sha256 FROM bb_snapshot_refs WHERE id=ANY($1::text[]) ORDER BY version',[refs])).rows;
  assert.deepEqual(rows.map(r=>r.version),[1,2,3,4]);assert.equal(new Set(rows.map(r=>r.content_sha256)).size,4);
  for(const row of rows)assert.equal(digest(objects.get(row.object_key)!),row.content_sha256.trim());
  await assert.rejects(savePromptSnapshot(pool,blobs,{owner,projectId:id,kind:'model_request',body:'bad-prompt'}),/Snapshot hash mismatch/);
  const key=`users/${owner}/projects/${id}/snapshots/${randomUUID()}`;objects.set(key,Buffer.from('bad-prompt'));
  await assert.rejects(saveSnapshotRef(pool,{owner,projectId:id,kind:'model_request',objectKey:key,sha256:digest('bad-prompt'),redactionVersion:'scrub_v1',blobs,verified:true} as any),/Snapshot hash mismatch/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE owner_user_id=$1',[owner])).rows[0].n,4);
 }finally{releaseRead();await Promise.allSettled(calls);await pool.end();}
});

test('project state writers serialize while existing foreign-key readers can upgrade without a delivery deadlock',
 {skip:!database,timeout:15000},async()=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),id=randomUUID();let a:import('pg').PoolClient|undefined,b:import('pg').PoolClient|undefined;
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'state_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,kind,name) VALUES($1,$2,'generation','Synthetic state locks')",[id,owner]);
  a=await pool.connect();b=await pool.connect();
  for(const client of [a,b]){await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='2s'");await client.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR KEY SHARE',[owner,id]);}
  // Both already reference the same project, as actual delivery and event writes do.
  const held=await project(a,owner,id,true);assert.equal(held.id,id);
  await b.query('SAVEPOINT peer');
  await assert.rejects(b.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR NO KEY UPDATE NOWAIT',[owner,id]),{code:'55P03'},'the original project write mutex remains exclusive');
  await b.query('ROLLBACK TO SAVEPOINT peer');
  await a.query("UPDATE bb_projects SET name='Synthetic updated state' WHERE owner_user_id=$1 AND id=$2",[owner,id]);await a.query('COMMIT');
  const later=await project(b,owner,id,true);assert.equal(later.name,'Synthetic updated state');await b.query('COMMIT');
 }finally{for(const client of [a,b])if(client){await client.query('ROLLBACK');client.release();}await pool.end();}
});
