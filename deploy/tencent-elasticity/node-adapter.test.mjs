import test from 'node:test';
import assert from 'node:assert/strict';
import {createNodeAdapter} from './node-adapter.mjs';
const h='a'.repeat(64),identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'e3432123-84b5-4f11-8b51-94a29eac1234'};
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
const envelope={identity,services,source_sha256:h,image_sha256:h,launch_manifest_sha256:h};
const config={runtime_uid:1000,region:identity.region,account_id:identity.account_id,image_sha256:h,compose_file:'/opt/bondbuddy/compose.yaml',services,private_pg:{system_identifier:'12345'}};
const row={...envelope,epoch:identity.epoch,system_identifier:'12345',expected_sessions_ready:true};
const contexts=[{id:'a'.repeat(64)},{id:'b'.repeat(64)}];
test('second runtime may finish starting later; same-epoch ready wait does not terminate healthy services',async()=>{
 let calls=0,waits=0;
 const adapter=createNodeAdapter(config,{enrollmentBroker:{enroll:async()=>envelope},runDocker:async()=>JSON.stringify({...row,state:++calls===1?'starting':'ready'}),wait:async()=>{waits++;}});
 await adapter.broker.enroll(identity);await adapter.runtime.verifyAllReady(contexts);assert.equal(calls,2);assert.equal(waits,1);
});
test('wrong PG identity/pins and stop_submitted fail immediately, without retrying as ordinary startup',async()=>{
 let waits=0;
 for(const bad of [{...row,state:'starting',source_sha256:'b'.repeat(64)},{...row,state:'starting',system_identifier:'wrong'},{...row,state:'stop_submitted'}]){
  const adapter=createNodeAdapter(config,{enrollmentBroker:{enroll:async()=>envelope},runDocker:async()=>JSON.stringify(bad),wait:async()=>{waits++;}});
  await adapter.broker.enroll(identity);await assert.rejects(adapter.runtime.verifyAllReady(contexts),/NODE_PG_(IDENTITY_DRIFT|READY_STATE_REJECTED)/);
 }
 assert.equal(waits,0);
});
