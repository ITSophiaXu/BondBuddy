import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {assertBatchAdmission} from './batch-admission.js';

function client(memberships:(string[]|null)[]){
 return {query:async(sql:string)=>sql.includes('SELECT 1 FROM bb_projects')
  ?{rowCount:1,rows:[{}]}:{rowCount:memberships.length,rows:memberships.map(membership=>({membership}))}} as unknown as PoolClient;
}
test('ordinary generation and update batches can admit four exact siblings, with no fifth or cross-batch escape',async()=>{
 for(const kind of ['generation','patch']){
  for(let active=0;active<4;active++)await assertBatchAdmission(client(Array.from({length:active},(_,i)=>[kind+':b','item-'+i,'1'])),'owner','scope',kind+':b','next');
  await assert.rejects(assertBatchAdmission(client(Array.from({length:4},(_,i)=>[kind+':b','item-'+i,'2'])),'owner','scope',kind+':b','next'),{code:'PROJECT_RUN_ACTIVE'});
  await assert.rejects(assertBatchAdmission(client([[kind+':other','item','4']]),'owner','scope',kind+':b','next'),{code:'PROJECT_RUN_ACTIVE'});
  await assert.rejects(assertBatchAdmission(client([[kind+':b','next','4']]),'owner','scope',kind+':b','next'),{code:'PROJECT_RUN_ACTIVE'});
  await assert.rejects(assertBatchAdmission(client([null]),'owner','scope',kind+':b','next'),{code:'PROJECT_RUN_ACTIVE'});
 }
});
