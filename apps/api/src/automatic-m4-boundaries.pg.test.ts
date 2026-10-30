import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {uid,transaction} from './data.js';
import {emptyM4Context,emptyM4Draft} from './m4-workspace.js';
import {creditBalance,grantCredits} from './billing.js';
import {action} from './queue.js';

const database=await isolatedTestDatabase(undefined,'automatic-m4-boundaries');
test('HTTP selected-document answers charge the response SKU; preparation and unclear inputs cannot buy or bypass an answer',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),owner=uid(),origin='https://synthetic.invalid';
 const app=createServer({pool,enableSubscriptionBilling:true,enableSyntheticQueue:true,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),paymentProviders:[]});
 const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin}});
 const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'m4_boundary_'+owner.slice(0,8)]);
  const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:uid(),name:'Synthetic billing boundary'})).topic;
  const base='/api/v1/m4/topics/'+topic.topic_id,draft=(await ok('PUT',base+'/drafts/init',{expected_version:0,input:emptyM4Draft('init')})).draft;
  const plain=emptyM4Context(),selected={...plain,document_type:'init',draft_version:draft.version},content='请说明本期收入增长的主要原因。';
  for(const context of [plain,selected]){const q=await ok('POST',base+'/quote',{kind:'qa',content,context});assert.equal(q.quote.points,'1218');assert.equal(q.quote.auto_charge,true);}
  const first=(await ok('POST',base+'/quote',{kind:'qa',content,context:selected})).quote;
  const short=await send('POST',base+'/messages',{submission_request_id:uid(),content,context:selected,execute:false,quote_id:first.quote_id});
  assert.equal(short.statusCode,402,short.body);assert.equal(short.json().code,'CREDITS_INSUFFICIENT');assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  for(const free of ['如何上传材料','这个呢？','保存任务要求：在募集书中说明收入下降原因','更新募集书，并解释收入变化']){
   const q=(await ok('POST',base+'/quote',{kind:'qa',content:free,context:selected})).quote;assert.equal(q.points,'0',free);
   const result=await ok('POST',base+'/messages',{submission_request_id:uid(),content:free,context:selected,execute:false,quote_id:q.quote_id});
   assert.equal((await pool.query('SELECT reservation_id FROM bb_runs WHERE id=$1',[result.run.run_id])).rows[0].reservation_id,null);
  }
  for(const multi of ['请说明收入增长原因，并说明负债下降原因','收入为何增长，负债为何下降']){
   const r=await send('POST',base+'/quote',{kind:'qa',content:multi,context:selected});assert.equal(r.statusCode,422,r.body);assert.equal(r.json().code,'SCOPE_UNSUPPORTED');
  }
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-response-funding',points:1218,expiresAt:null,actor:'synthetic',reason:'Isolated response boundary test'}));
  const ready=(await ok('POST',base+'/quote',{kind:'qa',content,context:selected})).quote,key=uid(),body={submission_request_id:key,content,context:selected,execute:false,quote_id:ready.quote_id};
  const paid=await ok('POST',base+'/messages',body),replay=await ok('POST',base+'/messages',body);assert.equal(replay.run.run_id,paid.run.run_id);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:1218});
  await action(pool,owner,paid.run.run_id,'cancel',uid());assert.deepEqual(await creditBalance(pool,owner),{available:1218,frozen:0});
 }finally{await app.close();await pool.end();}
});
